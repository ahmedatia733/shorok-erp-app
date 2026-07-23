-- Additive, backward-compatible meter-based costing. Legacy per-board fields
-- (product_variants.avg_cost, sales_invoice_lines.unit_cost_at_posting) are
-- preserved with their existing meaning. New columns hold the canonical
-- cost/valuation-per-square-meter model. Existing posted rows are NOT rewritten.

ALTER TABLE "product_variants"
  ADD COLUMN "avg_cost_per_meter" DECIMAL(14,4) NOT NULL DEFAULT 0;

ALTER TABLE "sales_invoice_lines"
  ADD COLUMN "unit_cost_per_meter_at_posting" DECIMAL(14,4),
  ADD COLUMN "line_cogs_at_posting"           DECIMAL(14,2);

-- Seed avg_cost_per_meter for EXISTING variants from reliable evidence:
-- per-board WAC ÷ board area = per-meter WAC. New purchases maintain it forward.
-- (Only a starting value for FUTURE sales; historical posted COGS is untouched.)
UPDATE "product_variants"
SET "avg_cost_per_meter" = ROUND("avg_cost" / "size_meters_per_board", 4)
WHERE "size_meters_per_board" > 0 AND "avg_cost" > 0;

-- Historical sales_invoice_lines keep NULL meter snapshots on purpose: reports
-- fall back to the legacy per-board COGS / posted COGS journal for those rows.
