/**
 * Return detection for cutover source rows.
 *
 * The sales sheet computes two columns that are negative as a matter of course:
 *
 *   المتبقي = التحصيل − المطلوب   → negative whenever the customer still owes
 *   GP      = المطلوب − التكلفة   → negative whenever the line lost money
 *
 * 113 of 235 source rows carry such a negative. Treating "any negative" as a
 * return would misclassify all of them, so those two DERIVED columns are
 * excluded from the signal set entirely: a negative there is structural, never
 * evidence of a reversal.
 */

export type ReturnClassification =
  | "PRE_CUTOVER_RETURN"
  | "CUTOVER_OR_POST_CUTOVER_RETURN"
  | "DATE_AMBIGUOUS_RETURN"
  | "NOT_A_RETURN";

export type ReturnTreatment =
  | "PRE_CUTOVER_ALREADY_REFLECTED_IN_OPENING"
  | "IMPORT_AS_SALES_RETURN"
  | "BLOCKED_PENDING_REVIEW"
  | "NONE";

/** Columns whose negativity is a genuine reversal signal. */
export const SIGNAL_COLUMNS = {
  boards: "negative_boards",
  size: "negative_size",
  meters: "negative_meters",
  price: "negative_price",
  grossAmount: "negative_gross_amount",
  collection: "negative_collection",
} as const;

/** Derived columns — a negative here is normal and is never a return signal. */
export const STRUCTURAL_NEGATIVE_COLUMNS = ["remaining", "grossProfit"] as const;

/** `مرتجع` / `مردود` are distinctive enough to match anywhere in a cell. */
const RETURN_MARKER = /(مرتجع|مرتجعات|مردود|مردودات)/;

/**
 * Bare `رد` only as a standalone word: the letters appear inside many ordinary
 * words (وارد, مورد, فردي, الورد) that have nothing to do with returns.
 */
const BARE_RAD = /(^|[\s()[\]،,\-/])رد(ي|ه|ة)?($|[\s()[\]،,\-/])/;

export function hasReturnMarker(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return RETURN_MARKER.test(t) || BARE_RAD.test(t);
}

export interface ReturnCandidateInput {
  /** Only genuine signal columns. Derived columns must not be passed here. */
  signalValues: Partial<Record<keyof typeof SIGNAL_COLUMNS, number | null | undefined>>;
  /** Values of the derived columns — recorded as noise, never as a signal. */
  structuralValues?: Array<number | null | undefined>;
  /** Any text cell on the row (customer, colour, note...). */
  textCells: Array<string | null | undefined>;
  /** Resolved transaction date, or null when it could not be determined. */
  resolvedDate: string | null;
  cutoverDate: string;
}

export interface ReturnCandidateResult {
  isCandidate: boolean;
  signals: string[];
  structuralNegativeCount: number;
  classification: ReturnClassification;
  treatment: ReturnTreatment;
}

export function classifyReturnCandidate(input: ReturnCandidateInput): ReturnCandidateResult {
  const signals: string[] = [];

  for (const [field, label] of Object.entries(SIGNAL_COLUMNS) as Array<
    [keyof typeof SIGNAL_COLUMNS, string]
  >) {
    const v = input.signalValues[field];
    if (typeof v === "number" && Number.isFinite(v) && v < 0) signals.push(label);
  }

  if (input.textCells.some(hasReturnMarker)) signals.push("arabic_return_marker");

  const structuralNegativeCount = (input.structuralValues ?? []).filter(
    (v) => typeof v === "number" && Number.isFinite(v) && v < 0,
  ).length;

  if (signals.length === 0) {
    return {
      isCandidate: false,
      signals,
      structuralNegativeCount,
      classification: "NOT_A_RETURN",
      treatment: "NONE",
    };
  }

  if (input.resolvedDate === null) {
    return {
      isCandidate: true,
      signals,
      structuralNegativeCount,
      classification: "DATE_AMBIGUOUS_RETURN",
      treatment: "BLOCKED_PENDING_REVIEW",
    };
  }

  const preCutover = input.resolvedDate < input.cutoverDate;
  return {
    isCandidate: true,
    signals,
    structuralNegativeCount,
    classification: preCutover ? "PRE_CUTOVER_RETURN" : "CUTOVER_OR_POST_CUTOVER_RETURN",
    treatment: preCutover
      ? // Its effect is already inside the 2026-08-01 customer and physical
        // inventory snapshots. Posting it again would double-count.
        "PRE_CUTOVER_ALREADY_REFLECTED_IN_OPENING"
      : // Must become a real SalesReturn document — never a negative invoice.
        "IMPORT_AS_SALES_RETURN",
  };
}
