/**
 * Reversal-aware tax-ledger display helpers.
 *
 * The tax account can hold both input (purchases) and output (sales) VAT, and a
 * cancellation posts a REVERSAL whose VAT line lands on the SAME side as its
 * original but with the opposite sign. Classifying by raw debit/credit would
 * push that reversal onto the wrong side and leave the cancelled invoice's tax
 * looking active. These helpers classify by the backend-provided VAT direction
 * and use the signed `vatAmount`, so reversals net their originals to zero.
 */
import type { TaxEntry, TaxLedgerResult } from "./tax-client";

export interface TaxSplitRow {
  entry: TaxEntry;
  amount: number;      // signed: reversal rows are negative
  isReversal: boolean;
  reversed: boolean;
}

/** Rows for one VAT side, dropping zero-net lines, with the signed amount. */
export function splitByDirection(
  entries: TaxEntry[],
  direction: "input" | "output",
): TaxSplitRow[] {
  return entries
    .filter((e) => e.vatDirection === direction && parseFloat(e.vatAmount || "0") !== 0)
    .map((e) => ({
      entry: e,
      amount: parseFloat(e.vatAmount || "0"),
      isReversal: e.isReversal,
      reversed: e.reversed,
    }));
}

/** Net total of one VAT side (originals minus their reversals). */
export function directionTotal(
  entries: TaxEntry[],
  direction: "input" | "output",
): number {
  return splitByDirection(entries, direction).reduce((s, r) => s + r.amount, 0);
}

export interface TaxSummary {
  inputVat: number;   // net input VAT for the period
  outputVat: number;  // net output VAT for the period
  net: number;        // output − input (closing net position)
  status: "liability" | "receivable" | "zero";
}

/** Period + closing summary, read from the netted backend totals. */
export function taxSummary(result: TaxLedgerResult): TaxSummary {
  return {
    inputVat:  parseFloat(result.periodTotals.inputVat)  || 0,
    outputVat: parseFloat(result.periodTotals.outputVat) || 0,
    net:       parseFloat(result.closing.net)            || 0,
    status:    result.closing.status,
  };
}
