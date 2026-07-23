/**
 * Shared reporting date-range + grouping helpers.
 *
 * Invoice/journal dates are stored as SQL DATE (no time component), so ranges
 * use INCLUSIVE [from, to] date bounds — unambiguous and free of the midnight
 * double-count problem that timestamptz ranges have. Presets are resolved in
 * the business timezone (Africa/Cairo) so "today"/"this month" line up with the
 * client's day, independent of the server locale.
 */

export const BUSINESS_TZ = "Africa/Cairo";
export type GroupBy = "day" | "month" | "quarter" | "year";

/** YYYY-MM-DD for `date` in the business timezone. */
export function businessDay(date = new Date()): string {
  // en-CA gives ISO YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ }).format(date);
}

function ymd(y: number, m1: number, d: number): string {
  return `${y}-${String(m1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function lastDayOfMonth(y: number, m1: number): number {
  return new Date(Date.UTC(y, m1, 0)).getUTCDate();
}

export type DatePreset =
  | "today" | "yesterday" | "this_week" | "this_month" | "last_month"
  | "q1" | "q2" | "q3" | "q4" | "this_year" | "last_year" | "custom";

export interface ResolvedRange { from: string; to: string }

/** Resolve a preset (or an explicit from/to for "custom") to inclusive dates. */
export function resolveRange(
  preset: DatePreset,
  explicit?: { from?: string; to?: string },
  now = new Date(),
): ResolvedRange {
  const todayStr = businessDay(now);
  const [ty, tm, td] = todayStr.split("-").map(Number) as [number, number, number];

  switch (preset) {
    case "custom":
      return { from: explicit?.from ?? todayStr, to: explicit?.to ?? todayStr };
    case "today":
      return { from: todayStr, to: todayStr };
    case "yesterday": {
      const d = new Date(Date.UTC(ty, tm - 1, td - 1));
      const s = ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      return { from: s, to: s };
    }
    case "this_week": {
      // Week starts Saturday (business week in EG); Sat=6 in getUTCDay.
      const dow = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay(); // 0=Sun..6=Sat
      const backToSat = (dow + 1) % 7; // days since Saturday
      const start = new Date(Date.UTC(ty, tm - 1, td - backToSat));
      return { from: ymd(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()), to: todayStr };
    }
    case "this_month":
      return { from: ymd(ty, tm, 1), to: ymd(ty, tm, lastDayOfMonth(ty, tm)) };
    case "last_month": {
      const y = tm === 1 ? ty - 1 : ty;
      const m = tm === 1 ? 12 : tm - 1;
      return { from: ymd(y, m, 1), to: ymd(y, m, lastDayOfMonth(y, m)) };
    }
    case "q1": return { from: ymd(ty, 1, 1), to: ymd(ty, 3, 31) };
    case "q2": return { from: ymd(ty, 4, 1), to: ymd(ty, 6, 30) };
    case "q3": return { from: ymd(ty, 7, 1), to: ymd(ty, 9, 30) };
    case "q4": return { from: ymd(ty, 10, 1), to: ymd(ty, 12, 31) };
    case "this_year": return { from: ymd(ty, 1, 1), to: ymd(ty, 12, 31) };
    case "last_year": return { from: ymd(ty - 1, 1, 1), to: ymd(ty - 1, 12, 31) };
  }
}

/** Postgres date_trunc/label expression for a grouping mode, over `col`. */
export function groupKeyExpr(groupBy: GroupBy, col: string): string {
  switch (groupBy) {
    case "day":     return `to_char(${col}, 'YYYY-MM-DD')`;
    case "month":   return `to_char(${col}, 'YYYY-MM')`;
    case "quarter": return `to_char(${col}, 'YYYY') || '-Q' || extract(quarter from ${col})::int`;
    case "year":    return `to_char(${col}, 'YYYY')`;
  }
}
