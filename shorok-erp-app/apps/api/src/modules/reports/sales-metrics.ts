/**
 * The SQL expressions that define what a sale is worth and what it cost.
 *
 * These were the private `M` map inside `sales-rep-reports.service.ts`. They are
 * lifted out unchanged so the invoice-profitability report computes revenue and
 * cost with the *same* arithmetic as the sales-representative reports. Two
 * copies of a profit formula eventually disagree, and the copy that disagrees is
 * the one nobody notices until an accountant does.
 *
 * All of them sum over `sales_invoice_lines l` joined to a CONFIRMED
 * `sales_invoices si` (plus `product_variants v` / `product_skus sku`).
 *
 * Two rules are worth stating out loud because getting either wrong silently
 * misstates profit:
 *
 *  - `line_total` is ALREADY net of the line discount and excludes VAT, and
 *    Σ line_total == invoice.subtotal. So `net` is the ex-VAT net sale and must
 *    never have the header `discount_amount` subtracted from it again — that
 *    column is a reporting echo of the same discount.
 *  - COGS is the cost SNAPSHOT taken when the invoice was posted, never the
 *    variant's current moving average. An old invoice's profit must not change
 *    because today's stock cost changed.
 */

/** The historical cost of a line: the meter-based snapshot, else the legacy
 *  per-board one. Both are stamped at posting; neither is recomputed. */
export const LINE_COGS_EXPR =
  `coalesce(l.line_cogs_at_posting, l.quantity * coalesce(l.unit_cost_at_posting, 0))`;

/**
 * Whether a line actually carries a cost snapshot at all.
 *
 * Lines confirmed before the costing migrations have neither column, and the
 * fallback above then evaluates to 0 — which reads as "this sale cost nothing"
 * and shows 100% margin. That is the single most dangerous number this report
 * could print, so every consumer must be able to tell a real zero from an
 * absent one. `false` here means "unknown", never "free".
 */
export const LINE_HAS_COST_EXPR =
  `(l.line_cogs_at_posting IS NOT NULL OR l.unit_cost_at_posting IS NOT NULL)`;

export const M = {
  invoices: `count(distinct si.id)`,
  boards:   `coalesce(sum(l.quantity), 0)`,
  meters:   `coalesce(sum(l.meters_quantity), 0)`,
  gross:    `coalesce(sum(l.meters_quantity * l.unit_price), 0)`,
  net:      `coalesce(sum(l.line_total), 0)`,
  discount: `coalesce(sum(l.meters_quantity * l.unit_price - l.line_total), 0)`,
  cogs:     `coalesce(sum(${LINE_COGS_EXPR}), 0)`,
  /** Lines whose historical cost was never recorded. */
  missingCostLines: `count(*) FILTER (WHERE NOT ${LINE_HAS_COST_EXPR})`,
} as const;
