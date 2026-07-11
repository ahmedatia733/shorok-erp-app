-- Phase 3B — sales-line posting-time snapshots. Additive/nullable so
-- historical rows and existing confirmed sales invoices are unaffected.
-- unit_cost_at_posting is stamped from product_variants.avg_cost at confirm
-- (never from the user-entered cost_price); tax_rate_at_posting from the
-- invoice tax rate in force at confirm.

ALTER TABLE "sales_invoice_lines"
  ADD COLUMN IF NOT EXISTS "unit_cost_at_posting" DECIMAL(14,2),
  ADD COLUMN IF NOT EXISTS "tax_rate_at_posting"  DECIMAL(5,2);
