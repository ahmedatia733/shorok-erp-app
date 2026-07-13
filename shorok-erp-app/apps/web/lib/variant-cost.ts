/**
 * Resolves the INFORMATIONAL cost shown for a product variant in the Sales
 * Invoice selector. Order of truth (business decision 2026-07-13):
 *   1. avg_cost (moving-average inventory cost — same value COGS uses) → "actual"
 *   2. else default_purchase_price_per_meter, labelled as an estimate → "estimate"
 *   3. else neither → "missing" (never render a fake 0)
 *
 * This is DISPLAY ONLY. COGS posting always uses the server-side avg_cost and
 * never the client-entered cost, so this resolution cannot affect accounting.
 * A zero/blank value in both fields is treated as missing, so a genuinely
 * missing cost is visually distinct from any real amount.
 */
export type CostSource = "actual" | "estimate" | "missing";

export interface ResolvedCost {
  /** The cost string to prefill, or null when nothing valid exists. */
  value: string | null;
  source: CostSource;
}

export const COST_MISSING_LABEL = "سعر التكلفة غير مسجل";
/** Shown when avg_cost is unavailable and the default purchase price is used instead. */
export const COST_ESTIMATE_LABEL = "تكلفة تقديرية";

const positive = (raw?: string | number | null): string | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(raw);
};

export function resolveVariantCost(
  avgCost?: string | number | null,
  defaultPurchasePrice?: string | number | null,
): ResolvedCost {
  const avg = positive(avgCost);
  if (avg !== null) return { value: avg, source: "actual" };
  const def = positive(defaultPurchasePrice);
  if (def !== null) return { value: def, source: "estimate" };
  return { value: null, source: "missing" };
}
