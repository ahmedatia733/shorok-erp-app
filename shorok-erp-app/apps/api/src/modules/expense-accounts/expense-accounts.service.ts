import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import type {
  ExpenseAccountDetail,
  ExpenseDashboard,
  ExpenseItem,
  ExpenseItemsQuery,
  ExpenseItemsResponse,
  ExpenseMovement,
  ExpenseMovementsQuery,
  ExpenseMovementsResponse,
  ExpenseSharePoint,
} from "@shorok/shared";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { PrismaService } from "../../prisma/prisma.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import { NotFoundError } from "../../common/errors/api-errors";

/**
 * Reading the expenses out of the ledger.
 *
 * There is no expense table behind any of this. An expense item is an account in
 * the Chart of Accounts whose category is EXPENSE, and an expense movement is a
 * journal line posted to one — so every figure here is the General Ledger, asked
 * a narrower question.
 *
 * The rule for which ledger rows count is not re-decided here. It is copied from
 * `FinancialReportsService.pnl()`, which is what the Income Statement and the
 * net-profit report use:
 *
 *   account:  is_leaf = true AND category = 'EXPENSE'
 *   entry:    status = 'POSTED' AND reversal_of_id IS NULL
 *   period:   entry_date between from and to
 *   amount:   debit − credit
 *
 * Dropping both a reversed original and its reversal mirror is why a cancelled
 * document contributes nothing. If that rule ever changes it must change in one
 * place; `expense-accounts.consistency.spec.ts` fails if these two ever disagree.
 *
 * Nothing in this file writes.
 */

/** The one predicate that decides whether a journal entry counts. */
const POSTED_ENTRY = Prisma.sql`je.status = 'POSTED' AND je.reversal_of_id IS NULL`;

const D = (v: unknown): Decimal => new Decimal((v ?? 0).toString());
const money = (v: Decimal): string => v.toFixed(2);

/** YYYY-MM-DD in UTC, matching how entry_date is stored (a bare date). */
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

interface ItemRow {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  active: boolean;
  period_amount: Prisma.Decimal | null;
  total_amount: Prisma.Decimal | null;
  last_movement: Date | null;
  period_count: bigint;
}

@Injectable()
export class ExpenseAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Defaults the period to the current calendar month when the caller gives no
   * dates — the question «كم صرفنا؟» almost always means this month.
   */
  resolveRange(from?: string, to?: string): { from: string; to: string } {
    if (from && to) return { from, to };
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    return { from: from ?? isoDate(start), to: to ?? isoDate(end) };
  }

  /**
   * Every expense item with its period figure, its all-time figure and when it
   * last moved — in one statement.
   *
   * It is one query rather than a list followed by a total per account because
   * the second shape is a request per expense item on every page load, and the
   * chart of accounts is the kind of thing that grows quietly.
   *
   * The qualifying ledger rows are joined as a derived table so an account with
   * no movement still appears (LEFT JOIN), while a row belonging to a reversed
   * entry contributes nothing rather than leaking in through the join.
   */
  async items(query: ExpenseItemsQuery): Promise<ExpenseItemsResponse> {
    const { from, to } = this.resolveRange(query.from, query.to);
    const search = query.search?.trim();

    const rows = await this.prisma.$queryRaw<ItemRow[]>(Prisma.sql`
      SELECT a.id,
             a.code,
             a.name_ar,
             a.name_en,
             a.active,
             COALESCE(SUM(m.amount) FILTER (WHERE m.entry_date BETWEEN ${from}::date AND ${to}::date), 0) AS period_amount,
             COALESCE(SUM(m.amount), 0) AS total_amount,
             MAX(m.entry_date) AS last_movement,
             COUNT(m.line_id) FILTER (WHERE m.entry_date BETWEEN ${from}::date AND ${to}::date) AS period_count
        FROM accounts a
        LEFT JOIN (
          SELECT jl.id AS line_id,
                 jl.account_id,
                 jl.debit - jl.credit AS amount,
                 je.entry_date
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.journal_entry_id
           WHERE ${POSTED_ENTRY}
        ) m ON m.account_id = a.id
       WHERE a.category = 'EXPENSE'
         AND a.is_leaf = true
       GROUP BY a.id, a.code, a.name_ar, a.name_en, a.active
       ORDER BY a.code ASC
    `);

    let items: ExpenseItem[] = rows.map((r) => ({
      accountId: r.id,
      code: r.code,
      nameAr: r.name_ar,
      nameEn: r.name_en,
      active: r.active,
      periodAmount: money(D(r.period_amount)),
      totalAmount: money(D(r.total_amount)),
      lastMovementDate: r.last_movement ? isoDate(r.last_movement) : null,
      periodMovementCount: Number(r.period_count),
    }));

    // Counted before filtering, so the badges describe the chart of accounts
    // rather than whatever the user has just typed into the search box.
    const activeCount = items.filter((i) => i.active).length;
    const inactiveCount = items.length - activeCount;

    if (query.status === "active") items = items.filter((i) => i.active);
    else if (query.status === "inactive") items = items.filter((i) => !i.active);

    if (search) {
      const needle = search.toLowerCase();
      items = items.filter(
        (i) =>
          i.code.toLowerCase().includes(needle) ||
          i.nameAr.includes(search) ||
          i.nameEn.toLowerCase().includes(needle),
      );
    }

    const periodTotal = items.reduce((s, i) => s.plus(i.periodAmount), new Decimal(0));
    const grandTotal = items.reduce((s, i) => s.plus(i.totalAmount), new Decimal(0));

    return {
      from,
      to,
      items,
      periodTotal: money(periodTotal),
      grandTotal: money(grandTotal),
      activeCount,
      inactiveCount,
      committedChanges: 0,
    };
  }

  /**
   * The overview.
   *
   * `periodTotal` is the same number the Income Statement prints for the same
   * dates. Today and month-to-date are separate windows over the same rule, so a
   * card can never disagree with the report it summarises.
   */
  async dashboard(fromStr?: string, toStr?: string): Promise<ExpenseDashboard> {
    const { from, to } = this.resolveRange(fromStr, toStr);

    const now = new Date();
    const today = isoDate(now);
    const monthStart = isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));

    // The window immediately before the selected one, of equal length, so
    // "compared with the previous period" means something for any range.
    const fromDate = new Date(`${from}T00:00:00Z`);
    const toDate = new Date(`${to}T00:00:00Z`);
    const spanDays = Math.max(1, Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1);
    const prevTo = new Date(fromDate.getTime() - 86_400_000);
    const prevFrom = new Date(prevTo.getTime() - (spanDays - 1) * 86_400_000);

    const [periodRows, monthRow, todayRow, prevRow, byMonthRows, activeRow] = await Promise.all([
      this.sumByAccount(from, to),
      this.sumTotal(monthStart, today),
      this.sumTotal(today, today),
      this.sumTotal(isoDate(prevFrom), isoDate(prevTo)),
      this.sumByMonth(from, to),
      this.prisma.account.count({ where: { category: "EXPENSE", isLeaf: true, active: true } }),
    ]);

    const periodTotal = periodRows.reduce((s, r) => s.plus(r.amount), new Decimal(0));

    const byItem: ExpenseSharePoint[] = periodRows
      .filter((r) => !D(r.amount).isZero())
      .map((r) => ({
        accountId: r.accountId,
        code: r.code,
        nameAr: r.nameAr,
        amount: money(D(r.amount)),
        percent: periodTotal.isZero() ? "" : D(r.amount).div(periodTotal).times(100).toFixed(2),
      }))
      .sort((a, b) => new Decimal(b.amount).comparedTo(new Decimal(a.amount)));

    const previousPeriodTotal = prevRow;
    const changeAmount = periodTotal.minus(previousPeriodTotal);

    return {
      from,
      to,
      periodTotal: money(periodTotal),
      monthToDateTotal: money(monthRow),
      todayTotal: money(todayRow),
      activeItemCount: activeRow,
      // The largest spender, which is only meaningful when something was spent.
      topItem: byItem.find((i) => new Decimal(i.amount).gt(0)) ?? null,
      previousPeriodTotal: money(previousPeriodTotal),
      changeAmount: money(changeAmount),
      changePercent: previousPeriodTotal.isZero()
        ? null
        : changeAmount.div(previousPeriodTotal.abs()).times(100).toFixed(2),
      byMonth: byMonthRows,
      byItem,
      // Copied from the Income Statement rather than asserted: expense figures
      // are all-branches because not every posting carries a branch dimension.
      branchAttributionComplete: false,
      committedChanges: 0,
    };
  }

  /** Period total per expense account. */
  private async sumByAccount(
    from: string,
    to: string,
  ): Promise<Array<{ accountId: string; code: string; nameAr: string; amount: string }>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; code: string; name_ar: string; amount: Prisma.Decimal | null }>
    >(Prisma.sql`
      SELECT a.id, a.code, a.name_ar, COALESCE(SUM(jl.debit - jl.credit), 0) AS amount
        FROM accounts a
        LEFT JOIN journal_lines jl ON jl.account_id = a.id
        LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
       WHERE a.category = 'EXPENSE'
         AND a.is_leaf = true
         AND (jl.id IS NULL OR (${POSTED_ENTRY} AND je.entry_date BETWEEN ${from}::date AND ${to}::date))
       GROUP BY a.id, a.code, a.name_ar
       ORDER BY a.code ASC
    `);
    return rows.map((r) => ({
      accountId: r.id,
      code: r.code,
      nameAr: r.name_ar,
      amount: money(D(r.amount)),
    }));
  }

  /** One number: total expense over a window. */
  private async sumTotal(from: string, to: string): Promise<Decimal> {
    const rows = await this.prisma.$queryRaw<Array<{ amount: Prisma.Decimal | null }>>(Prisma.sql`
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS amount
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.journal_entry_id
        JOIN accounts a ON a.id = jl.account_id
       WHERE a.category = 'EXPENSE'
         AND a.is_leaf = true
         AND ${POSTED_ENTRY}
         AND je.entry_date BETWEEN ${from}::date AND ${to}::date
    `);
    return D(rows[0]?.amount);
  }

  /** The period broken into calendar months, for the trend. */
  private async sumByMonth(from: string, to: string): Promise<Array<{ month: string; amount: string }>> {
    const rows = await this.prisma.$queryRaw<Array<{ month: string; amount: Prisma.Decimal | null }>>(
      Prisma.sql`
      SELECT to_char(date_trunc('month', je.entry_date), 'YYYY-MM') AS month,
             COALESCE(SUM(jl.debit - jl.credit), 0) AS amount
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.journal_entry_id
        JOIN accounts a ON a.id = jl.account_id
       WHERE a.category = 'EXPENSE'
         AND a.is_leaf = true
         AND ${POSTED_ENTRY}
         AND je.entry_date BETWEEN ${from}::date AND ${to}::date
       GROUP BY 1
       ORDER BY 1 ASC
    `,
    );
    return rows.map((r) => ({ month: r.month, amount: money(D(r.amount)) }));
  }

  /**
   * The movements list.
   *
   * `limit`/`offset` page the rows, but `totalCount` and `totalAmount` describe
   * the whole filtered set — so the footer total is the total of the filter, not
   * of the page, and a PDF asking for everything gets everything.
   */
  async movements(query: ExpenseMovementsQuery): Promise<ExpenseMovementsResponse> {
    const { from, to } = this.resolveRange(query.from, query.to);
    const where = this.movementWhere(query, from, to);

    const [countRow] = await this.prisma.$queryRaw<Array<{ n: bigint; amount: Prisma.Decimal | null }>>(
      Prisma.sql`
        SELECT COUNT(*) AS n, COALESCE(SUM(jl.debit - jl.credit), 0) AS amount
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.journal_entry_id
          JOIN accounts a ON a.id = jl.account_id
         WHERE ${where}
      `,
    );

    const rows = await this.prisma.$queryRaw<
      Array<{
        line_id: string;
        entry_id: string;
        entry_number: bigint;
        entry_date: Date;
        entry_type: string;
        reference: string | null;
        description: string;
        account_id: string;
        code: string;
        name_ar: string;
        debit: Prisma.Decimal;
        credit: Prisma.Decimal;
        note: string | null;
        branch_id: string | null;
        branch_name: string | null;
      }>
    >(Prisma.sql`
      SELECT jl.id AS line_id, je.id AS entry_id, je.entry_number, je.entry_date,
             je.entry_type, je.reference, je.description,
             a.id AS account_id, a.code, a.name_ar,
             jl.debit, jl.credit, jl.note,
             jl.branch_id, b.name_ar AS branch_name
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.journal_entry_id
        JOIN accounts a ON a.id = jl.account_id
        LEFT JOIN branches b ON b.id = jl.branch_id
       WHERE ${where}
       ORDER BY je.entry_date DESC, je.entry_number DESC, jl.id ASC
       LIMIT ${query.limit} OFFSET ${query.offset}
    `);

    return {
      from,
      to,
      rows: await this.attachCounterAccounts(rows),
      totalCount: Number(countRow?.n ?? 0),
      totalAmount: money(D(countRow?.amount)),
      limit: query.limit,
      offset: query.offset,
      committedChanges: 0,
    };
  }

  /** One expense item, with the movements behind its figures. */
  async detail(accountId: string, fromStr?: string, toStr?: string): Promise<ExpenseAccountDetail> {
    const { from, to } = this.resolveRange(fromStr, toStr);

    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, code: true, nameAr: true, nameEn: true, active: true, category: true, isLeaf: true },
    });
    if (!account || account.category !== "EXPENSE") {
      throw new NotFoundError({ reason: "EXPENSE_ITEM_NOT_FOUND", accountId });
    }

    const [summary] = await this.prisma.$queryRaw<
      Array<{
        period_amount: Prisma.Decimal | null;
        total_amount: Prisma.Decimal | null;
        last_movement: Date | null;
        period_count: bigint;
      }>
    >(Prisma.sql`
      SELECT COALESCE(SUM(m.amount) FILTER (WHERE m.entry_date BETWEEN ${from}::date AND ${to}::date), 0) AS period_amount,
             COALESCE(SUM(m.amount), 0) AS total_amount,
             MAX(m.entry_date) AS last_movement,
             COUNT(m.line_id) FILTER (WHERE m.entry_date BETWEEN ${from}::date AND ${to}::date) AS period_count
        FROM (
          SELECT jl.id AS line_id, jl.debit - jl.credit AS amount, je.entry_date
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.journal_entry_id
           WHERE jl.account_id = ${accountId}::uuid AND ${POSTED_ENTRY}
        ) m
    `);

    const { rows } = await this.movements({
      from,
      to,
      accountId,
      limit: 500,
      offset: 0,
    } as ExpenseMovementsQuery);

    return {
      from,
      to,
      accountId: account.id,
      code: account.code,
      nameAr: account.nameAr,
      nameEn: account.nameEn,
      active: account.active,
      periodAmount: money(D(summary?.period_amount)),
      totalAmount: money(D(summary?.total_amount)),
      lastMovementDate: summary?.last_movement ? isoDate(summary.last_movement) : null,
      periodMovementCount: Number(summary?.period_count ?? 0),
      movements: rows,
      committedChanges: 0,
    };
  }

  /** The filter, written once so the count, the total and the page always agree. */
  private movementWhere(query: ExpenseMovementsQuery, from: string, to: string): Prisma.Sql {
    const parts: Prisma.Sql[] = [
      Prisma.sql`a.category = 'EXPENSE'`,
      Prisma.sql`a.is_leaf = true`,
      POSTED_ENTRY,
      Prisma.sql`je.entry_date BETWEEN ${from}::date AND ${to}::date`,
      // A line that neither debits nor credits is not a movement.
      Prisma.sql`(jl.debit <> 0 OR jl.credit <> 0)`,
    ];
    if (query.accountId) parts.push(Prisma.sql`a.id = ${query.accountId}::uuid`);
    if (query.search) {
      const like = `%${query.search}%`;
      parts.push(
        Prisma.sql`(je.description ILIKE ${like} OR jl.note ILIKE ${like} OR je.reference ILIKE ${like} OR je.entry_number::text = ${query.search})`,
      );
    }
    if (query.minAmount) parts.push(Prisma.sql`ABS(jl.debit - jl.credit) >= ${query.minAmount}::numeric`);
    if (query.maxAmount) parts.push(Prisma.sql`ABS(jl.debit - jl.credit) <= ${query.maxAmount}::numeric`);
    return Prisma.join(parts, " AND ");
  }

  /**
   * The other side of each entry.
   *
   * Fetched for the whole page in one query rather than per row — the counter
   * account is the single most useful column on this screen ("what did we pay
   * it from"), and it must not cost a query per line to show.
   *
   * Only real lines of the same entry are reported. Nothing is inferred about a
   * payment method or a cashbox that the journal does not actually say.
   */
  private async attachCounterAccounts(
    rows: Array<{
      line_id: string;
      entry_id: string;
      entry_number: bigint;
      entry_date: Date;
      entry_type: string;
      reference: string | null;
      description: string;
      account_id: string;
      code: string;
      name_ar: string;
      debit: Prisma.Decimal;
      credit: Prisma.Decimal;
      note: string | null;
      branch_id: string | null;
      branch_name: string | null;
    }>,
  ): Promise<ExpenseMovement[]> {
    if (rows.length === 0) return [];

    const entryIds = [...new Set(rows.map((r) => r.entry_id))];
    const counters = await this.prisma.journalLine.findMany({
      where: { journalEntryId: { in: entryIds }, account: { category: { not: "EXPENSE" } } },
      select: {
        journalEntryId: true,
        debit: true,
        credit: true,
        account: { select: { id: true, code: true, nameAr: true } },
      },
    });

    const byEntry = new Map<string, ExpenseMovement["counterAccounts"]>();
    for (const c of counters) {
      const amount = D(c.credit).minus(D(c.debit)).abs();
      if (amount.isZero()) continue;
      const list = byEntry.get(c.journalEntryId) ?? [];
      const existing = list.find((x) => x.accountId === c.account.id);
      if (existing) existing.amount = money(new Decimal(existing.amount).plus(amount));
      else
        list.push({
          accountId: c.account.id,
          code: c.account.code,
          nameAr: c.account.nameAr,
          amount: money(amount),
        });
      byEntry.set(c.journalEntryId, list);
    }

    return rows.map((r) => ({
      lineId: r.line_id,
      journalEntryId: r.entry_id,
      entryNumber: r.entry_number.toString(),
      entryDate: isoDate(r.entry_date),
      entryType: r.entry_type,
      reference: r.reference,
      accountId: r.account_id,
      accountCode: r.code,
      accountNameAr: r.name_ar,
      debit: money(D(r.debit)),
      credit: money(D(r.credit)),
      amount: money(D(r.debit).minus(D(r.credit))),
      note: r.note,
      entryDescription: r.description,
      counterAccounts: byEntry.get(r.entry_id) ?? [],
      branchId: r.branch_id,
      branchNameAr: r.branch_name,
    }));
  }
}
