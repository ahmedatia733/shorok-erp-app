/**
 * Source date resolution for the cutover workbook.
 *
 * The workbook stores dates two different ways, and only ONE of them carries
 * the day/month defect:
 *
 *   Rule A — a true Excel date cell (numeric serial + a date numFmt).
 *            These were entered as d/m/yyyy but stored as if m/d/yyyy, so the
 *            true day sits in the month position. Corrected by swapping.
 *
 *   Rule B — a text cell such as "16/7/2026". These were typed as text and were
 *            never reinterpreted by Excel, so they are ALREADY correct.
 *            Applying rule A to them would corrupt them.
 *
 * Evidence for rule A: the sales sheet spans eleven distinct stored months but
 * only two distinct stored days ({7, 8}) — impossible for real transaction
 * dates, and the exact signature of a d/m ↔ m/d swap.
 */

export type DateBasis =
  | "DATE_CELL_SWAPPED"
  | "TEXT_DMY_UNAMBIGUOUS"
  | "TEXT_MDY_UNAMBIGUOUS"
  | "TEXT_RESOLVED_BY_MONTH_HINT"
  | "BLOCKED_DATE_AMBIGUOUS"
  | "BLOCKED_DATE_INVALID"
  | "NO_DATE";

export interface ResolvedDate {
  iso: string | null;
  basis: DateBasis;
  /** The value exactly as stored, kept so evidence is never overwritten. */
  storedRepresentation: string;
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Rule A: an Excel serial from a genuine date-formatted cell. */
export function resolveDateCell(serial: number): ResolvedDate {
  const stored = String(serial);
  if (!Number.isFinite(serial) || serial < 1 || serial > 60_000) {
    return { iso: null, basis: "BLOCKED_DATE_INVALID", storedRepresentation: stored };
  }
  const d = new Date(EXCEL_EPOCH + Math.trunc(serial) * 86_400_000);
  const storedIso = d.toISOString().slice(0, 10);
  // Swap: the stored DAY is the true month, the stored MONTH is the true day.
  const corrected = iso(d.getUTCFullYear(), d.getUTCDate(), d.getUTCMonth() + 1);
  if (!corrected) {
    return { iso: null, basis: "BLOCKED_DATE_INVALID", storedRepresentation: storedIso };
  }
  return { iso: corrected, basis: "DATE_CELL_SWAPPED", storedRepresentation: storedIso };
}

/** Rule B: a text date. Never swapped. */
export function resolveTextDate(text: string, monthHint?: string): ResolvedDate {
  const stored = text.trim();
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(stored);
  if (!m) return { iso: null, basis: "BLOCKED_DATE_AMBIGUOUS", storedRepresentation: stored };

  const a = Number(m[1]);
  const b = Number(m[2]);
  const y = Number(m[3]);

  // One field above 12 settles the order with no further evidence needed.
  if (a > 12 && b <= 12) {
    const v = iso(y, b, a);
    return v
      ? { iso: v, basis: "TEXT_DMY_UNAMBIGUOUS", storedRepresentation: stored }
      : { iso: null, basis: "BLOCKED_DATE_INVALID", storedRepresentation: stored };
  }
  if (b > 12 && a <= 12) {
    const v = iso(y, a, b);
    return v
      ? { iso: v, basis: "TEXT_MDY_UNAMBIGUOUS", storedRepresentation: stored }
      : { iso: null, basis: "BLOCKED_DATE_INVALID", storedRepresentation: stored };
  }

  // Both ≤ 12 — corroborate with an explicit month label if the row carries one.
  const hint = MONTH_NAMES[(monthHint ?? "").trim().toLowerCase()];
  if (hint) {
    if (b === hint && a !== hint) {
      const v = iso(y, b, a);
      if (v) return { iso: v, basis: "TEXT_RESOLVED_BY_MONTH_HINT", storedRepresentation: stored };
    }
    if (a === hint && b !== hint) {
      const v = iso(y, a, b);
      if (v) return { iso: v, basis: "TEXT_RESOLVED_BY_MONTH_HINT", storedRepresentation: stored };
    }
  }

  // No safe answer. Never invent one.
  return { iso: null, basis: "BLOCKED_DATE_AMBIGUOUS", storedRepresentation: stored };
}

/**
 * An opening-balance row is a SNAPSHOT at the cutover date, not a transaction.
 * When its stored date resolves to something other than the cutover date, the
 * anomaly is recorded and the cutover date is used for posting — the source
 * evidence is preserved untouched, never rewritten.
 */
export interface SnapshotDateDecision {
  postingDate: string;
  anomaly: boolean;
  storedRepresentation: string;
  resolvedIso: string | null;
}

export function applySnapshotDate(resolved: ResolvedDate, cutoverDate: string): SnapshotDateDecision {
  return {
    postingDate: cutoverDate,
    anomaly: resolved.iso !== null && resolved.iso !== cutoverDate,
    storedRepresentation: resolved.storedRepresentation,
    resolvedIso: resolved.iso,
  };
}
