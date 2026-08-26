/**
 * How an amount should READ in a deduction section of the income statement
 * (cost of sales, expenses).
 *
 * The report's calculation convention is debit-normal: an expense account's
 * amount is `debit − credit`, so money spent is POSITIVE and the net profit is
 * `grossProfit − totalExpenses`. That arithmetic is correct and lives in the
 * API; nothing here re-does it.
 *
 * What this decides is only the SIGN THE READER SEES, and there is one case the
 * old rendering got wrong. Parentheses are the accounting convention for a
 * deduction, so wrapping an amount that is ALREADY negative produces a row that
 * contradicts the statement it sits in: `(900)` reads as "we spent 900" while
 * the same page shows net profit 900 HIGHER. An expense account with a credit
 * balance is not money spent — it is a refund, a recovery, or an entry posted on
 * the wrong side — and it genuinely increases profit.
 *
 * So a negative amount is shown as a plain positive magnitude marked as a
 * credit, never in deduction parentheses. The reader then sees an expense line
 * that ADDS to profit and can tell immediately that the account carries a
 * credit, which is the fact worth noticing.
 */
export type DeductionKind = "DEDUCTION" | "CREDIT" | "ZERO";

export interface DeductionDisplay {
  /** DEDUCTION → money spent; CREDIT → a credit balance that increased profit. */
  kind: DeductionKind;
  /** The magnitude to format — always non-negative, so the sign is carried by
   *  `kind` and by the presentation rather than smuggled into the number. */
  magnitude: string;
  /** Whether the presentation should use deduction parentheses. */
  parenthesise: boolean;
}

export function deductionDisplay(amount: string | number): DeductionDisplay {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n) || n === 0) {
    return { kind: "ZERO", magnitude: "0", parenthesise: true };
  }
  if (n < 0) {
    return { kind: "CREDIT", magnitude: String(Math.abs(n)), parenthesise: false };
  }
  return { kind: "DEDUCTION", magnitude: String(n), parenthesise: true };
}

/** Arabic marker for a credit balance sitting in a deduction section. */
export const CREDIT_LABEL_AR = "دائن";
export const CREDIT_HINT_AR = "رصيد دائن في حساب مصروف — يزيد الربح بدلاً من أن يخفضه";
