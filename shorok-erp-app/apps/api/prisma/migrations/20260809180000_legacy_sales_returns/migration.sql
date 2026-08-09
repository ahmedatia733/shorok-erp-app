-- مردودات بدون فواتير — returns of goods sold before this ERP existed.
--
-- Purely additive: two new tables, their indexes and their foreign keys.
-- Nothing existing is altered, dropped, renamed or backfilled. No enum is
-- touched — the stock movement reuses the existing SALE_RETURN member and is
-- told apart by its reference_type, exactly as sales_return already is.
--
-- The document deliberately has NO original_sales_invoice_id. A legacy return
-- has no electronic invoice; the paper is recorded as a reference, never as a
-- relation, so nothing here can fabricate an invoice that never existed.

CREATE TABLE "legacy_sales_returns" (
  "id"                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "return_number"           BIGSERIAL NOT NULL,
  "customer_id"             UUID NOT NULL,
  "branch_id"               UUID NOT NULL,
  "paper_invoice_number"    VARCHAR(120) NOT NULL,
  "paper_invoice_date"      DATE NOT NULL,
  "return_date"             DATE NOT NULL,
  "status"                  VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  "settlement_mode"         VARCHAR(40) NOT NULL DEFAULT 'KEEP_AS_CUSTOMER_CREDIT',
  "notes"                   VARCHAR(1000),
  "subtotal"                DECIMAL(14,2) NOT NULL DEFAULT 0,
  "discount_total"          DECIMAL(14,2) NOT NULL DEFAULT 0,
  "tax_total"               DECIMAL(14,2) NOT NULL DEFAULT 0,
  "grand_total"             DECIMAL(14,2) NOT NULL DEFAULT 0,
  "cogs_total"              DECIMAL(14,2) NOT NULL DEFAULT 0,
  "journal_entry_id"        UUID,
  "cogs_journal_entry_id"   UUID,
  "customer_transaction_id" UUID,
  "sales_returns_account_id" UUID,
  "confirmed_at"            TIMESTAMPTZ(6),
  "confirmed_by"            UUID,
  "cancelled_at"            TIMESTAMPTZ(6),
  "cancelled_by"            UUID,
  "cancellation_reason"     VARCHAR(300),
  "created_by"              UUID NOT NULL,
  "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "legacy_sales_returns_status_ck"
    CHECK ("status" IN ('DRAFT','CONFIRMED','CANCELLED')),
  -- The one settlement this document has. Cash and bank refunds are not part
  -- of this feature, and the database says so rather than trusting the UI.
  CONSTRAINT "legacy_sales_returns_settlement_ck"
    CHECK ("settlement_mode" = 'KEEP_AS_CUSTOMER_CREDIT')
);

CREATE UNIQUE INDEX "legacy_sales_returns_return_number_key"
  ON "legacy_sales_returns" ("return_number");
CREATE INDEX "legacy_sales_returns_customer_id_idx"  ON "legacy_sales_returns" ("customer_id");
CREATE INDEX "legacy_sales_returns_branch_id_idx"    ON "legacy_sales_returns" ("branch_id");
CREATE INDEX "legacy_sales_returns_status_idx"       ON "legacy_sales_returns" ("status");
CREATE INDEX "legacy_sales_returns_return_date_idx"  ON "legacy_sales_returns" ("return_date" DESC);
CREATE INDEX "legacy_sales_returns_paper_invoice_number_idx"
  ON "legacy_sales_returns" ("paper_invoice_number");

ALTER TABLE "legacy_sales_returns"
  ADD CONSTRAINT "legacy_sales_returns_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "legacy_sales_returns_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "legacy_sales_returns_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "legacy_sales_returns_confirmed_by_fkey"
    FOREIGN KEY ("confirmed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "legacy_sales_returns_cancelled_by_fkey"
    FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "legacy_sales_return_lines" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "legacy_sales_return_id"   UUID NOT NULL,
  "product_variant_id"       UUID NOT NULL,
  "length_m"                 DECIMAL(14,4),
  "width_m"                  DECIMAL(14,4),
  "returned_boards"          DECIMAL(14,4) NOT NULL,
  "returned_meters"          DECIMAL(14,4) NOT NULL,
  "unit_price_per_meter"     DECIMAL(14,2) NOT NULL,
  "discount_pct"             DECIMAL(5,2)  NOT NULL DEFAULT 0,
  "tax_rate"                 DECIMAL(5,2)  NOT NULL DEFAULT 0,
  "line_subtotal"            DECIMAL(14,2) NOT NULL,
  "line_discount"            DECIMAL(14,2) NOT NULL DEFAULT 0,
  "line_net_ex_tax"          DECIMAL(14,2) NOT NULL,
  "line_tax"                 DECIMAL(14,2) NOT NULL DEFAULT 0,
  "line_total"               DECIMAL(14,2) NOT NULL,
  -- The WAC frozen at confirmation. Null while the document is a draft: the
  -- cost is only known at the moment the goods actually come back.
  "cost_per_meter_snapshot"  DECIMAL(14,4),
  "line_cogs"                DECIMAL(14,2) NOT NULL DEFAULT 0,
  "note"                     VARCHAR(300),
  CONSTRAINT "legacy_sales_return_lines_boards_positive_ck"  CHECK ("returned_boards" > 0),
  CONSTRAINT "legacy_sales_return_lines_meters_positive_ck"  CHECK ("returned_meters" > 0),
  CONSTRAINT "legacy_sales_return_lines_price_nonneg_ck"     CHECK ("unit_price_per_meter" >= 0),
  -- A cost basis is never negative, and never invented: it is either the
  -- snapshot taken at confirmation or nothing at all.
  CONSTRAINT "legacy_sales_return_lines_cost_nonneg_ck"
    CHECK ("cost_per_meter_snapshot" IS NULL OR "cost_per_meter_snapshot" >= 0)
);

CREATE INDEX "legacy_sales_return_lines_return_idx"
  ON "legacy_sales_return_lines" ("legacy_sales_return_id");
CREATE INDEX "legacy_sales_return_lines_variant_idx"
  ON "legacy_sales_return_lines" ("product_variant_id");

ALTER TABLE "legacy_sales_return_lines"
  ADD CONSTRAINT "legacy_sales_return_lines_return_fkey"
    FOREIGN KEY ("legacy_sales_return_id") REFERENCES "legacy_sales_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "legacy_sales_return_lines_variant_fkey"
    FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
