-- Phase 3C: expenses posting via the PostingEngine.
-- Additive only — all columns nullable/defaulted so existing rows are unaffected
-- and legacy no-account expenses keep working (record-only, journal_entry_id null).

ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "expense_category_id" UUID,
  ADD COLUMN IF NOT EXISTS "supplier_id"         UUID,
  ADD COLUMN IF NOT EXISTS "taxable"             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "tax_rate_at_posting" DECIMAL(5,2);

-- Nullable FKs (no data migration; existing rows keep NULL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_expense_category_id_fkey') THEN
    ALTER TABLE "expenses"
      ADD CONSTRAINT "expenses_expense_category_id_fkey"
      FOREIGN KEY ("expense_category_id") REFERENCES "expense_categories"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_supplier_id_fkey') THEN
    ALTER TABLE "expenses"
      ADD CONSTRAINT "expenses_supplier_id_fkey"
      FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
