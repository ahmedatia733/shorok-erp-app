-- Sales Invoices migration

CREATE SEQUENCE "sales_invoices_invoice_number_seq" START 1;

CREATE TABLE "sales_invoices" (
  "id"                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "invoice_number"        BIGINT        NOT NULL
                            DEFAULT nextval('"sales_invoices_invoice_number_seq"'),
  "invoice_date"          DATE          NOT NULL,
  "due_date"              DATE,
  "customer_id"           UUID          NOT NULL REFERENCES "customers"("id"),
  "branch_id"             UUID          NOT NULL REFERENCES "branches"("id"),
  "status"                VARCHAR(20)   NOT NULL DEFAULT 'DRAFT',
  "notes"                 VARCHAR(1000),
  "subtotal"              DECIMAL(14,2) NOT NULL DEFAULT 0,
  "discount_amount"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  "tax_rate"              DECIMAL(5,2)  NOT NULL DEFAULT 0,
  "tax_amount"            DECIMAL(14,2) NOT NULL DEFAULT 0,
  "grand_total"           DECIMAL(14,2) NOT NULL DEFAULT 0,
  "total_cost"            DECIMAL(14,2) NOT NULL DEFAULT 0,
  "ar_account_id"         UUID REFERENCES "accounts"("id"),
  "revenue_account_id"    UUID REFERENCES "accounts"("id"),
  "tax_account_id"        UUID REFERENCES "accounts"("id"),
  "cogs_account_id"       UUID REFERENCES "accounts"("id"),
  "inventory_account_id"  UUID REFERENCES "accounts"("id"),
  "journal_entry_id"      UUID REFERENCES "journal_entries"("id"),
  "cogs_journal_entry_id" UUID REFERENCES "journal_entries"("id"),
  "customer_tx_id"        UUID REFERENCES "customer_transactions"("id"),
  "created_by"            UUID          NOT NULL REFERENCES "users"("id"),
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "sales_invoices_number_key" UNIQUE ("invoice_number"),
  CONSTRAINT "sales_invoices_status_chk"
    CHECK (status IN ('DRAFT','CONFIRMED','CANCELLED','PAID'))
);

ALTER SEQUENCE "sales_invoices_invoice_number_seq"
  OWNED BY "sales_invoices"."invoice_number";

CREATE TABLE "sales_invoice_lines" (
  "id"                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "invoice_id"          UUID          NOT NULL
                          REFERENCES "sales_invoices"("id") ON DELETE CASCADE,
  "product_variant_id"  UUID          NOT NULL
                          REFERENCES "product_variants"("id"),
  "quantity"            DECIMAL(14,4) NOT NULL,
  "unit_label"          VARCHAR(30)   NOT NULL DEFAULT 'وحدة',
  "unit_price"          DECIMAL(14,2) NOT NULL,
  "cost_price"          DECIMAL(14,2) NOT NULL DEFAULT 0,
  "discount_pct"        DECIMAL(5,2)  NOT NULL DEFAULT 0,
  "line_total"          DECIMAL(14,2) NOT NULL,
  "line_cost"           DECIMAL(14,2) NOT NULL DEFAULT 0,
  "note"                VARCHAR(300)
);

CREATE INDEX "sales_invoices_customer_idx" ON "sales_invoices"("customer_id");
CREATE INDEX "sales_invoices_date_idx"     ON "sales_invoices"("invoice_date" DESC);
CREATE INDEX "sil_invoice_idx"             ON "sales_invoice_lines"("invoice_id");
