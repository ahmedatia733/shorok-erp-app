-- Add accounting linkage columns to purchase_invoices

ALTER TABLE "purchase_invoices"
  ADD COLUMN IF NOT EXISTS "ap_account_id"         UUID REFERENCES "accounts"("id"),
  ADD COLUMN IF NOT EXISTS "tax_account_id"        UUID REFERENCES "accounts"("id"),
  ADD COLUMN IF NOT EXISTS "inventory_account_id"  UUID REFERENCES "accounts"("id"),
  ADD COLUMN IF NOT EXISTS "journal_entry_id"      UUID REFERENCES "journal_entries"("id");
