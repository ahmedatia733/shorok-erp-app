import { Controller, Get, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import {
  IncomeStatementQuerySchema,
  type IncomeStatementQuery,
} from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("reports")
export class IncomeStatementController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /reports/income-statement?from=&to= — OWNER only.
   *
   * Computes a P&L statement for the given date range using journal entries.
   */
  @Get("income-statement")
  @Roles("OWNER")
  async incomeStatement(
    @Query(new ZodValidationPipe(IncomeStatementQuerySchema)) query: IncomeStatementQuery,
  ) {
    const from = new Date(query.from);
    const to = new Date(query.to);

    // Fetch all leaf accounts in relevant categories with their journal lines in range
    const accounts = await this.prisma.account.findMany({
      where: {
        isLeaf: true,
        category: { in: ["REVENUE", "COST_OF_SALES", "EXPENSE"] },
      },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        category: true,
        journalLines: {
          where: {
            journalEntry: {
              entryDate: { gte: from, lte: to },
            },
          },
          select: { debit: true, credit: true },
        },
      },
    });

    type AccountLine = { accountId: string; code: string; nameAr: string; nameEn: string; amount: string };

    let revenue = new Decimal(0);
    let costOfSales = new Decimal(0);
    const revenueLines: AccountLine[] = [];
    const cogsLines: AccountLine[] = [];
    const expenseRows: AccountLine[] = [];

    for (const acc of accounts) {
      const totalDebit = acc.journalLines.reduce(
        (sum, l) => sum.plus(l.debit.toString()),
        new Decimal(0),
      );
      const totalCredit = acc.journalLines.reduce(
        (sum, l) => sum.plus(l.credit.toString()),
        new Decimal(0),
      );

      if (acc.category === "REVENUE") {
        const amount = totalCredit.minus(totalDebit);
        revenue = revenue.plus(amount);
        if (!amount.isZero()) {
          revenueLines.push({ accountId: acc.id, code: acc.code, nameAr: acc.nameAr, nameEn: acc.nameEn, amount: amount.toFixed(2) });
        }
      } else if (acc.category === "COST_OF_SALES") {
        const amount = totalDebit.minus(totalCredit);
        costOfSales = costOfSales.plus(amount);
        if (!amount.isZero()) {
          cogsLines.push({ accountId: acc.id, code: acc.code, nameAr: acc.nameAr, nameEn: acc.nameEn, amount: amount.toFixed(2) });
        }
      } else if (acc.category === "EXPENSE") {
        const amount = totalDebit.minus(totalCredit);
        if (!amount.isZero()) {
          expenseRows.push({ accountId: acc.id, code: acc.code, nameAr: acc.nameAr, nameEn: acc.nameEn, amount: amount.toFixed(2) });
        }
      }
    }

    const grossProfit = revenue.minus(costOfSales);
    const totalExpenses = expenseRows.reduce(
      (sum, e) => sum.plus(new Decimal(e.amount)),
      new Decimal(0),
    );
    const netProfit = grossProfit.minus(totalExpenses);
    const grossMarginPct = revenue.isZero()
      ? "0.00"
      : grossProfit.div(revenue).times(100).toFixed(2);

    return {
      revenue: revenue.toFixed(2),
      revenueLines,
      costOfSales: costOfSales.toFixed(2),
      cogsLines,
      grossProfit: grossProfit.toFixed(2),
      grossMarginPct,
      expenses: expenseRows,
      totalExpenses: totalExpenses.toFixed(2),
      netProfit: netProfit.toFixed(2),
      from: query.from,
      to: query.to,
    };
  }
}
