import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { Prisma, PrismaService } from "../../prisma/prisma.service";

/** Normal balance side of an account — determines how debit/credit affect the running balance. */
export type NormalSide = "DEBIT" | "CREDIT";

/**
 * The statement-only source type for «مردود بدون فاتورة». It is deliberately
 * NOT a JournalSourceType value: adding one would need a schema migration and
 * would still leave already-posted rows carrying SALES_RETURN. This is a
 * presentation discriminator resolved from persisted ids.
 */
export const LEGACY_SALES_RETURN_SOURCE = "LEGACY_SALES_RETURN";

export interface StatementRow {
  journalEntryId: string;
  journalLineId: string;
  entryNumber: string;
  entryDate: string; // YYYY-MM-DD
  reference: string | null;
  description: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
  accountId: string;
  sourceType: string | null;
  sourceId: string | null;
  isReversal: boolean;
  reversalOfId: string | null;
  partyType: string | null;
  partyId: string | null;
  branchId: string | null;
}

export interface StatementResult {
  openingBalance: string;
  periodDebit: string;
  periodCredit: string;
  endingBalance: string;
  rows: StatementRow[];
}

/** A journal line joined to its entry — the shape {@link StatementService.reduce} folds. */
export interface StatementLineInput {
  id: string;
  accountId: string;
  debit: Prisma.Decimal | string;
  credit: Prisma.Decimal | string;
  note: string | null;
  partyType: string | null;
  partyId: string | null;
  branchId: string | null;
  journalEntry: {
    id: string;
    entryNumber: bigint | number;
    entryDate: Date;
    reference: string | null;
    description: string | null;
    sourceType: string | null;
    sourceId: string | null;
    reversalOfId: string | null;
    status: string;
  };
}

/**
 * Builds an account/party statement directly from the General Ledger
 * (journal_entries + journal_lines) — the single source of truth. Rows for
 * both POSTED and REVERSED entries are included so a reversal shows as its real
 * opposite movement and the net balance stays correct; nothing is summed with
 * legacy customer_transactions / payments / order_collections.
 *
 * Normal side controls the balance formula:
 *   DEBIT  (ASSET/EXPENSE/COST_OF_SALES, AR_CONTROL): balance += debit − credit
 *   CREDIT (LIABILITY/EQUITY/REVENUE,     AP_CONTROL): balance += credit − debit
 */
@Injectable()
export class StatementService {
  constructor(private readonly prisma: PrismaService) {}

  /** Map an account category to its normal balance side. */
  static normalSideForCategory(category: string): NormalSide {
    return category === "LIABILITY" || category === "EQUITY" || category === "REVENUE" ? "CREDIT" : "DEBIT";
  }

  /** Include + deterministic ordering every statement query relies on. */
  static readonly lineInclude = {
    journalEntry: {
      select: {
        id: true, entryNumber: true, entryDate: true, reference: true,
        description: true, sourceType: true, sourceId: true, reversalOfId: true, status: true,
      },
    },
  } as const;

  /** Deterministic: entry date, then entry number, then line id. */
  static readonly lineOrderBy: Prisma.JournalLineOrderByWithRelationInput[] = [
    { journalEntry: { entryDate: "asc" } },
    { journalEntry: { entryNumber: "asc" } },
    { id: "asc" },
  ];

  async compute(
    lineWhere: Prisma.JournalLineWhereInput,
    normalSide: NormalSide,
    from?: string,
    to?: string,
  ): Promise<StatementResult> {
    const lines = await this.prisma.journalLine.findMany({
      where: lineWhere,
      include: StatementService.lineInclude,
      orderBy: StatementService.lineOrderBy,
    });
    const result = StatementService.reduce(lines, () => normalSide, from, to);
    // A legacy return («مردود بدون فاتورة») posts its journal with sourceType
    // SALES_RETURN — JournalSourceType has no value of its own for it — but its
    // sourceId is a legacy_sales_returns id, not a sales_returns one. Left
    // alone the statement links such a row to the ordinary sales-return page,
    // which cannot find that id and shows "not found". Resolving it from the
    // stored id keeps the distinction structural rather than text-matched, and
    // repairs rows posted long before this code existed without rewriting them.
    await this.markLegacyReturnRows(result.rows);
    return result;
  }

  /**
   * Folds ordered journal lines into a statement. Pure, so the single-account
   * and consolidated endpoints share one implementation and cannot drift apart.
   *
   * `sideFor` resolves the normal side per line, which is what lets a mixed
   * category (e.g. "all accounts") total each account on its own side rather
   * than forcing one formula across asset and liability rows.
   */
  static reduce(
    lines: StatementLineInput[],
    sideFor: (line: StatementLineInput) => NormalSide,
    from?: string,
    to?: string,
  ): StatementResult {
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;
    const signed = (debit: Decimal, credit: Decimal, side: NormalSide) =>
      side === "DEBIT" ? debit.sub(credit) : credit.sub(debit);

    let opening = new Decimal(0);
    let running = new Decimal(0);
    let periodDebit = new Decimal(0);
    let periodCredit = new Decimal(0);
    const rows: StatementRow[] = [];

    for (const l of lines) {
      const debit = new Decimal(l.debit.toString());
      const credit = new Decimal(l.credit.toString());
      const entryDate = l.journalEntry.entryDate;
      const side = sideFor(l);

      if (fromDate && entryDate < fromDate) {
        opening = opening.add(signed(debit, credit, side)); // before the window → opening balance only
        continue;
      }
      if (toDate && entryDate > toDate) continue; // after the window → excluded

      if (rows.length === 0) running = opening; // first in-window row starts from opening
      running = running.add(signed(debit, credit, side));
      periodDebit = periodDebit.add(debit);
      periodCredit = periodCredit.add(credit);

      rows.push({
        journalEntryId: l.journalEntry.id,
        journalLineId: l.id,
        entryNumber: String(l.journalEntry.entryNumber),
        entryDate: entryDate.toISOString().slice(0, 10),
        reference: l.journalEntry.reference ?? null,
        description: l.note ?? l.journalEntry.description ?? null,
        debit: debit.toFixed(2),
        credit: credit.toFixed(2),
        runningBalance: running.toFixed(2),
        accountId: l.accountId,
        sourceType: l.journalEntry.sourceType ?? null,
        sourceId: l.journalEntry.sourceId ?? null,
        isReversal: l.journalEntry.reversalOfId != null,
        reversalOfId: l.journalEntry.reversalOfId ?? null,
        partyType: l.partyType ?? null,
        partyId: l.partyId ?? null,
        branchId: l.branchId ?? null,
      });
    }

    // Ending balance is the last in-window running balance, or the opening
    // balance when the window has no movements.
    const endingBalance = rows.length ? new Decimal(rows[rows.length - 1].runningBalance) : opening;

    return {
      openingBalance: opening.toFixed(2),
      periodDebit: periodDebit.toFixed(2),
      periodCredit: periodCredit.toFixed(2),
      endingBalance: endingBalance.toFixed(2),
      rows,
    };
  }

  /**
   * Re-labels the SALES_RETURN rows whose document is actually a legacy return.
   *
   * One query for the whole page, so a long statement costs a single extra
   * lookup. A row keeps SALES_RETURN unless its id genuinely exists in
   * legacy_sales_returns, so an ordinary return is never mistaken for one.
   */
  private markLegacyReturnRows = (rows: Array<{ sourceType: string | null; sourceId: string | null }>) =>
    markLegacyReturnRows(this.prisma, rows);
}

/**
 * Re-labels the SALES_RETURN rows whose document is actually a legacy return.
 *
 * One query per statement, so a long page costs a single extra lookup. A row
 * keeps SALES_RETURN unless its id genuinely exists in legacy_sales_returns,
 * so an ordinary return is never mistaken for one. Shared by the single-party
 * statement and the consolidated one so the two cannot drift apart.
 */
export async function markLegacyReturnRows(
  prisma: PrismaService,
  rows: Array<{ sourceType: string | null; sourceId: string | null }>,
): Promise<void> {
  const candidates = [...new Set(
    rows.filter((r) => r.sourceType === "SALES_RETURN" && r.sourceId).map((r) => r.sourceId!),
  )];
  if (candidates.length === 0) return;
  const legacy = await prisma.legacySalesReturn.findMany({
    where: { id: { in: candidates } },
    select: { id: true },
  });
  if (legacy.length === 0) return;
  const legacyIds = new Set(legacy.map((l) => l.id));
  for (const r of rows) {
    if (r.sourceType === "SALES_RETURN" && r.sourceId && legacyIds.has(r.sourceId)) {
      r.sourceType = LEGACY_SALES_RETURN_SOURCE;
    }
  }
}
