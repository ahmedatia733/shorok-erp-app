import { Controller, Get, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { BalanceSheetQuerySchema, type BalanceSheetQuery } from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("reports")
export class BalanceSheetController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /reports/balance-sheet?asOf=YYYY-MM-DD
   * Returns a classified balance sheet grouping accounts into assets,
   * liabilities, and equity as of the given date.
   * Revenue / expense accounts are excluded (they flow through retained earnings).
   */
  @Get("balance-sheet")
  @Roles("OWNER", "ACCOUNTANT")
  async balanceSheet(
    @Query(new ZodValidationPipe(BalanceSheetQuerySchema)) query: BalanceSheetQuery,
  ) {
    const asOfStr = query.asOf ?? new Date().toISOString().slice(0, 10);
    const asOf = new Date(asOfStr);
    asOf.setUTCHours(23, 59, 59, 999);

    // Only pull balance-sheet account categories
    const accounts = await this.prisma.account.findMany({
      where: {
        isLeaf: true,
        active: true,
        category: { in: ["ASSET", "LIABILITY", "EQUITY"] },
      },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        category: true,
        accountType: true,
        journalLines: {
          where: {
            journalEntry: { entryDate: { lte: asOf } },
          },
          select: { debit: true, credit: true },
        },
      },
      orderBy: { code: "asc" },
    });

    type AccountRow = {
      accountId: string;
      code: string;
      nameAr: string;
      nameEn: string;
      accountType: string;
      balance: string;
    };

    const assets: AccountRow[] = [];
    const liabilities: AccountRow[] = [];
    const equity: AccountRow[] = [];

    let totalAssets = new Decimal(0);
    let totalLiabilities = new Decimal(0);
    let totalEquity = new Decimal(0);

    for (const acc of accounts) {
      const totalDebit = acc.journalLines.reduce(
        (sum, l) => sum.plus(l.debit.toString()),
        new Decimal(0),
      );
      const totalCredit = acc.journalLines.reduce(
        (sum, l) => sum.plus(l.credit.toString()),
        new Decimal(0),
      );

      // Normal balance logic
      let balance: Decimal;
      if (acc.category === "ASSET") {
        // Assets: debit-normal (debit increases asset value)
        balance = totalDebit.minus(totalCredit);
      } else {
        // Liabilities and Equity: credit-normal (credit increases balance)
        balance = totalCredit.minus(totalDebit);
      }

      // Skip zero-balance accounts
      if (balance.isZero()) continue;

      const row: AccountRow = {
        accountId: acc.id,
        code: acc.code,
        nameAr: acc.nameAr,
        nameEn: acc.nameEn,
        accountType: acc.accountType,
        balance: balance.toFixed(2),
      };

      if (acc.category === "ASSET") {
        assets.push(row);
        totalAssets = totalAssets.plus(balance);
      } else if (acc.category === "LIABILITY") {
        liabilities.push(row);
        totalLiabilities = totalLiabilities.plus(balance);
      } else {
        equity.push(row);
        totalEquity = totalEquity.plus(balance);
      }
    }

    const difference = totalAssets.minus(totalLiabilities.plus(totalEquity));

    return {
      asOf: asOfStr,
      assets,
      totalAssets: totalAssets.toFixed(2),
      liabilities,
      totalLiabilities: totalLiabilities.toFixed(2),
      equity,
      totalEquity: totalEquity.toFixed(2),
      difference: difference.toFixed(2),
    };
  }
}
