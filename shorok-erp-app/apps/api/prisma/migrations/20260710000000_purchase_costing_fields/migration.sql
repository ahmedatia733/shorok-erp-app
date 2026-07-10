-- Phase 3A — costing fields for weighted-average cost (WAC) and posting-time
-- snapshots. All additive/nullable-or-defaulted so historical rows and the 8
-- legacy flows are unaffected.
--
-- avg_cost starts at 0 for existing variants and builds FORWARD from new
-- purchase invoice postings (approved option A, test environment). The real
-- opening stock/cost correction belongs to Phase 4 opening balances +
-- reconciliation — this is a documented Phase 3A limitation.

ALTER TABLE "product_variants"
  ADD COLUMN IF NOT EXISTS "avg_cost"        DECIMAL(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cost_updated_at" TIMESTAMPTZ(6);

ALTER TABLE "purchase_invoice_lines"
  ADD COLUMN IF NOT EXISTS "unit_cost_at_posting" DECIMAL(14,2),
  ADD COLUMN IF NOT EXISTS "tax_rate_at_posting"  DECIMAL(5,2);
