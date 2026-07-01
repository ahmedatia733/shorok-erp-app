-- Add GL account and journal entry link to expenses
ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "gl_account_id"      UUID REFERENCES "accounts"("id"),
  ADD COLUMN IF NOT EXISTS "payment_gl_account_id" UUID REFERENCES "accounts"("id"),
  ADD COLUMN IF NOT EXISTS "journal_entry_id"   UUID REFERENCES "journal_entries"("id");

-- Add phone field to customers (already exists in schema, ensure it is present)
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "phone" VARCHAR(30);
