import { Controller, Get, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { TrialBalanceQuerySchema, type TrialBalanceQuery } from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("reports")
export class TrialBalanceController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /reports/trial-balance?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Returns a full trial balance for the period, including opening balances,
   * period movements, and closing balances for every active leaf account
   * that has any activity.
   */
  @Get("trial-balance")
  @Roles("OWNER", "ACCOUNTANT")
  async trialBalance(
    @Query(new ZodValidationPipe(TrialBalanceQuerySchema)) query: TrialBalanceQuery,
  ) {
    const from = new Date(query.from);
    // Include the entire "to" day by setting time to end of day
    const to = new Date(query.to);
    to.setUTCHours(23, 59, 59, 999);

    // Fetch all active leaf accounts with their journal lines
    const accounts = await this.prisma.account.findMany({
      where: { isLeaf: true, active: true },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        category: true,
        journalLines: {
          select: {
            debit: true,
            credit: true,
            journalEntry: { select: { entryDate: true } },
          },
        },
      },
      orderBy: { code: "asc" },
    });

    type Row = {
      accountId: string;
      code: string;
      nameAr: string;
      nameEn: string;
      category: string;
      openingDebit: string;
      openingCredit: string;
      periodDebit: string;
      periodCredit: string;
      closingDebit: string;
      closingCredit: string;
    };

    const rows: Row[] = [];

    let totalOpeningDebit = new Decimal(0);
    let totalOpeningCredit = new Decimal(0);
    let totalPeriodDebit = new Decimal(0);
    let totalPeriodCredit = new Decimal(0);
    let totalClosingDebit = new Decimal(0);
    let totalClosingCredit = new Decimal(0);

    for (const acc of accounts) {
      let openingDebit = new Decimal(0);
      let openingCredit = new Decimal(0);
      let periodDebit = new Decimal(0);
      let periodCredit = new Decimal(0);

      for (const line of acc.journalLines) {
        const entryDate = line.journalEntry.entryDate;
        if (entryDate < from) {
          // Opening balance: all movements before the start date
          openingDebit = openingDebit.plus(line.debit.toString());
          openingCredit = openingCredit.plus(line.credit.toString());
        } else if (entryDate <= to) {
          // Period movement: within [from, to]
          periodDebit = periodDebit.plus(line.debit.toString());
          periodCredit = periodCredit.plus(line.credit.toString());
        }
      }

      const closingDebit = openingDebit.plus(periodDebit);
      const closingCredit = openingCredit.plus(periodCredit);

      // Only include accounts with any non-zero value
      if (
        openingDebit.isZero() &&
        openingCredit.isZero() &&
        periodDebit.isZero() &&
        periodCredit.isZero()
      ) {
        continue;
      }

      rows.push({
        accountId: acc.id,
        code: acc.code,
        nameAr: acc.nameAr,
        nameEn: acc.nameEn,
        category: acc.category,
        openingDebit: openingDebit.toFixed(2),
        openingCredit: openingCredit.toFixed(2),
        periodDebit: periodDebit.toFixed(2),
        periodCredit: periodCredit.toFixed(2),
        closingDebit: closingDebit.toFixed(2),
        closingCredit: closingCredit.toFixed(2),
      });

      totalOpeningDebit = totalOpeningDebit.plus(openingDebit);
      totalOpeningCredit = totalOpeningCredit.plus(openingCredit);
      totalPeriodDebit = totalPeriodDebit.plus(periodDebit);
      totalPeriodCredit = totalPeriodCredit.plus(periodCredit);
      totalClosingDebit = totalClosingDebit.plus(closingDebit);
      totalClosingCredit = totalClosingCredit.plus(closingCredit);
    }

    return {
      from: query.from,
      to: query.to,
      rows,
      totals: {
        openingDebit: totalOpeningDebit.toFixed(2),
        openingCredit: totalOpeningCredit.toFixed(2),
        periodDebit: totalPeriodDebit.toFixed(2),
        periodCredit: totalPeriodCredit.toFixed(2),
        closingDebit: totalClosingDebit.toFixed(2),
        closingCredit: totalClosingCredit.toFixed(2),
      },
    };
  }
}
