-- Item 1: GL journal entry columns on order_collections
ALTER TABLE "order_collections"
  ADD COLUMN IF NOT EXISTS "cash_account_id"    UUID REFERENCES "accounts"("id"),
  ADD COLUMN IF NOT EXISTS "ar_account_id"      UUID REFERENCES "accounts"("id"),
  ADD COLUMN IF NOT EXISTS "journal_entry_id"   UUID REFERENCES "journal_entries"("id");

-- Item 2: GL journal entry columns on factory_ledger_entries (for payments)
ALTER TABLE "factory_ledger_entries"
  ADD COLUMN IF NOT EXISTS "debit_account_id"   UUID REFERENCES "accounts"("id"),
  ADD COLUMN IF NOT EXISTS "credit_account_id"  UUID REFERENCES "accounts"("id"),
  ADD COLUMN IF NOT EXISTS "journal_entry_id"   UUID REFERENCES "journal_entries"("id");

-- Item 5: Link customer_orders → sales_invoices
ALTER TABLE "customer_orders"
  ADD COLUMN IF NOT EXISTS "sales_invoice_id"   UUID REFERENCES "sales_invoices"("id");

-- Item 6: Link purchase_invoices → factory_ledger_entries
ALTER TABLE "purchase_invoices"
  ADD COLUMN IF NOT EXISTS "factory_ledger_entry_id" UUID REFERENCES "factory_ledger_entries"("id");

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS "customer_orders_sales_invoice_id_idx"
  ON "customer_orders"("sales_invoice_id");
CREATE INDEX IF NOT EXISTS "purchase_invoices_factory_ledger_entry_id_idx"
  ON "purchase_invoices"("factory_ledger_entry_id");
