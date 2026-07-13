import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { Prisma, PrismaService } from "../../prisma/prisma.service";

/** Normal balance side of an account — determines how debit/credit affect the running balance. */
export type NormalSide = "DEBIT" | "CREDIT";

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

  async compute(
    lineWhere: Prisma.JournalLineWhereInput,
    normalSide: NormalSide,
    from?: string,
    to?: string,
  ): Promise<StatementResult> {
    const lines = await this.prisma.journalLine.findMany({
      where: lineWhere,
      include: {
        journalEntry: {
          select: {
            id: true, entryNumber: true, entryDate: true, reference: true,
            description: true, sourceType: true, sourceId: true, reversalOfId: true, status: true,
          },
        },
      },
      // Deterministic: entry date, then entry number, then line id.
      orderBy: [
        { journalEntry: { entryDate: "asc" } },
        { journalEntry: { entryNumber: "asc" } },
        { id: "asc" },
      ],
    });

    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;
    const signed = (debit: Decimal, credit: Decimal) =>
      normalSide === "DEBIT" ? debit.sub(credit) : credit.sub(debit);

    let opening = new Decimal(0);
    let running = new Decimal(0);
    let periodDebit = new Decimal(0);
    let periodCredit = new Decimal(0);
    const rows: StatementRow[] = [];

    for (const l of lines) {
      const debit = new Decimal(l.debit.toString());
      const credit = new Decimal(l.credit.toString());
      const entryDate = l.journalEntry.entryDate;

      if (fromDate && entryDate < fromDate) {
        opening = opening.add(signed(debit, credit)); // before the window → opening balance only
        continue;
      }
      if (toDate && entryDate > toDate) continue; // after the window → excluded

      if (rows.length === 0) running = opening; // first in-window row starts from opening
      running = running.add(signed(debit, credit));
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
}
