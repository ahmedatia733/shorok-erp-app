import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { PrismaService } from "../../prisma/prisma.service";

export interface PnlLine { accountId: string; code: string; nameAr: string; nameEn: string; amount: string }
export interface Pnl {
  from: string; to: string;
  branchAttributionComplete: boolean; // false → all-branches only, not branch-filterable
  revenue: string; revenueLines: PnlLine[];
  costOfSales: string; cogsLines: PnlLine[];
  grossProfit: string; grossMarginPct: string;
  expenses: PnlLine[]; totalExpenses: string;
  netProfit: string;
}

/**
 * Journal-based P&L (the accounting source of truth), shared by the income
 * statement and the net-profit report so they reconcile exactly. Includes ONLY
 * active POSTED entries: status = 'POSTED' AND reversal_of_id IS NULL — this
 * drops both a REVERSED original and its POSTED reversal mirror, so a cancelled
 * transaction nets to zero. Never derived from invoices; never mutates data.
 */
@Injectable()
export class FinancialReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async pnl(fromStr: string, toStr: string): Promise<Pnl> {
    const from = new Date(fromStr);
    const to = new Date(toStr);
    const accounts = await this.prisma.account.findMany({
      where: { isLeaf: true, category: { in: ["REVENUE", "COST_OF_SALES", "EXPENSE"] } },
      select: {
        id: true, code: true, nameAr: true, nameEn: true, category: true,
        journalLines: {
          where: { journalEntry: { status: "POSTED", reversalOfId: null, entryDate: { gte: from, lte: to } } },
          select: { debit: true, credit: true },
        },
      },
    });

    let revenue = new Decimal(0), costOfSales = new Decimal(0);
    const revenueLines: PnlLine[] = [], cogsLines: PnlLine[] = [], expenseRows: PnlLine[] = [];
    for (const acc of accounts) {
      const dr = acc.journalLines.reduce((s, l) => s.plus(l.debit.toString()), new Decimal(0));
      const cr = acc.journalLines.reduce((s, l) => s.plus(l.credit.toString()), new Decimal(0));
      const line = (amount: Decimal): PnlLine => ({ accountId: acc.id, code: acc.code, nameAr: acc.nameAr, nameEn: acc.nameEn, amount: amount.toFixed(2) });
      if (acc.category === "REVENUE") {
        const amount = cr.minus(dr); revenue = revenue.plus(amount);
        if (!amount.isZero()) revenueLines.push(line(amount));
      } else if (acc.category === "COST_OF_SALES") {
        const amount = dr.minus(cr); costOfSales = costOfSales.plus(amount);
        if (!amount.isZero()) cogsLines.push(line(amount));
      } else {
        const amount = dr.minus(cr);
        if (!amount.isZero()) expenseRows.push(line(amount));
      }
    }
    const grossProfit = revenue.minus(costOfSales);
    const totalExpenses = expenseRows.reduce((s, e) => s.plus(e.amount), new Decimal(0));
    const netProfit = grossProfit.minus(totalExpenses);
    return {
      from: fromStr, to: toStr,
      // This is an ALL-BRANCHES statement: it takes no branchId and is NOT
      // branch-filterable, because not every posted journal source yet carries a
      // canonical branch dimension on its lines (sales/purchase invoice postings
      // don't). Sales returns DO carry branch dims, so their revenue/COGS effect
      // is reflected here automatically via the contra-revenue debit + COGS
      // credit. The flag is surfaced so no consumer mistakes this for branch P&L.
      branchAttributionComplete: false,
      revenue: revenue.toFixed(2), revenueLines,
      costOfSales: costOfSales.toFixed(2), cogsLines,
      grossProfit: grossProfit.toFixed(2),
      grossMarginPct: revenue.isZero() ? "0.00" : grossProfit.div(revenue).times(100).toFixed(2),
      expenses: expenseRows, totalExpenses: totalExpenses.toFixed(2),
      netProfit: netProfit.toFixed(2),
    };
  }
}
