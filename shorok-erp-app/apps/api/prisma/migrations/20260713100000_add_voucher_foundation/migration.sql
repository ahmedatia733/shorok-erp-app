-- Phase 4B-1a — Voucher foundation (ADDITIVE ONLY).
-- New enum + 4 new tables (receipt/payment vouchers + their allocations) with
-- their sequences, indexes, and foreign keys to existing tables. No existing
-- table/column/enum/constraint is altered or dropped; no data; no backfill.
-- Vouchers are read/posted only in Phase 4B-2/4B-3 — these tables start empty.

-- ── Enum ─────────────────────────────────────────────────────────────
CREATE TYPE "VoucherStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- ── Sequences for human-facing voucher numbers ───────────────────────
CREATE SEQUENCE "receipt_vouchers_voucher_number_seq" START 1;
CREATE SEQUENCE "payment_vouchers_voucher_number_seq" START 1;

-- ── receipt_vouchers ─────────────────────────────────────────────────
CREATE TABLE "receipt_vouchers" (
  "id"                        UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  "voucher_number"            BIGINT          NOT NULL DEFAULT nextval('"receipt_vouchers_voucher_number_seq"'),
  "voucher_date"              DATE            NOT NULL,
  "branch_id"                 UUID            NOT NULL,
  "customer_id"               UUID            NOT NULL,
  "treasury_account_id"       UUID            NOT NULL,
  "amount"                    DECIMAL(18,2)   NOT NULL,
  "reference"                 VARCHAR(100),
  "memo"                      VARCHAR(300),
  "status"                    "VoucherStatus" NOT NULL DEFAULT 'DRAFT',
  "period_id"                 UUID,
  "journal_entry_id"          UUID,
  "reversal_journal_entry_id" UUID,
  "created_by"                UUID            NOT NULL,
  "posted_by"                 UUID,
  "reversed_by"               UUID,
  "posted_at"                 TIMESTAMPTZ(6),
  "reversed_at"               TIMESTAMPTZ(6),
  "created_at"                TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMPTZ(6)  NOT NULL,
  CONSTRAINT "receipt_vouchers_voucher_number_key" UNIQUE ("voucher_number"),
  CONSTRAINT "receipt_vouchers_journal_entry_id_key" UNIQUE ("journal_entry_id"),
  CONSTRAINT "receipt_vouchers_reversal_journal_entry_id_key" UNIQUE ("reversal_journal_entry_id"),
  CONSTRAINT "receipt_vouchers_branch_id_fkey"           FOREIGN KEY ("branch_id")                 REFERENCES "branches"("id")          ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "receipt_vouchers_customer_id_fkey"         FOREIGN KEY ("customer_id")               REFERENCES "customers"("id")         ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "receipt_vouchers_treasury_account_id_fkey" FOREIGN KEY ("treasury_account_id")        REFERENCES "accounts"("id")          ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "receipt_vouchers_period_id_fkey"           FOREIGN KEY ("period_id")                 REFERENCES "financial_periods"("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "receipt_vouchers_journal_entry_id_fkey"    FOREIGN KEY ("journal_entry_id")          REFERENCES "journal_entries"("id")   ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "receipt_vouchers_reversal_je_id_fkey"      FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "journal_entries"("id")   ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "receipt_vouchers_created_by_fkey"          FOREIGN KEY ("created_by")                REFERENCES "users"("id")             ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "receipt_vouchers_posted_by_fkey"           FOREIGN KEY ("posted_by")                 REFERENCES "users"("id")             ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "receipt_vouchers_reversed_by_fkey"         FOREIGN KEY ("reversed_by")               REFERENCES "users"("id")             ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX "receipt_vouchers_customer_id_idx"         ON "receipt_vouchers"("customer_id");
CREATE INDEX "receipt_vouchers_treasury_account_id_idx" ON "receipt_vouchers"("treasury_account_id");
CREATE INDEX "receipt_vouchers_status_idx"              ON "receipt_vouchers"("status");
CREATE INDEX "receipt_vouchers_period_id_idx"           ON "receipt_vouchers"("period_id");
CREATE INDEX "receipt_vouchers_branch_id_voucher_date_idx" ON "receipt_vouchers"("branch_id", "voucher_date" DESC);

-- ── payment_vouchers ─────────────────────────────────────────────────
CREATE TABLE "payment_vouchers" (
  "id"                        UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  "voucher_number"            BIGINT          NOT NULL DEFAULT nextval('"payment_vouchers_voucher_number_seq"'),
  "voucher_date"              DATE            NOT NULL,
  "branch_id"                 UUID            NOT NULL,
  "supplier_id"               UUID            NOT NULL,
  "treasury_account_id"       UUID            NOT NULL,
  "amount"                    DECIMAL(18,2)   NOT NULL,
  "reference"                 VARCHAR(100),
  "memo"                      VARCHAR(300),
  "status"                    "VoucherStatus" NOT NULL DEFAULT 'DRAFT',
  "period_id"                 UUID,
  "journal_entry_id"          UUID,
  "reversal_journal_entry_id" UUID,
  "created_by"                UUID            NOT NULL,
  "posted_by"                 UUID,
  "reversed_by"               UUID,
  "posted_at"                 TIMESTAMPTZ(6),
  "reversed_at"               TIMESTAMPTZ(6),
  "created_at"                TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMPTZ(6)  NOT NULL,
  CONSTRAINT "payment_vouchers_voucher_number_key" UNIQUE ("voucher_number"),
  CONSTRAINT "payment_vouchers_journal_entry_id_key" UNIQUE ("journal_entry_id"),
  CONSTRAINT "payment_vouchers_reversal_journal_entry_id_key" UNIQUE ("reversal_journal_entry_id"),
  CONSTRAINT "payment_vouchers_branch_id_fkey"           FOREIGN KEY ("branch_id")                 REFERENCES "branches"("id")          ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "payment_vouchers_supplier_id_fkey"         FOREIGN KEY ("supplier_id")               REFERENCES "suppliers"("id")         ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "payment_vouchers_treasury_account_id_fkey" FOREIGN KEY ("treasury_account_id")        REFERENCES "accounts"("id")          ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "payment_vouchers_period_id_fkey"           FOREIGN KEY ("period_id")                 REFERENCES "financial_periods"("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "payment_vouchers_journal_entry_id_fkey"    FOREIGN KEY ("journal_entry_id")          REFERENCES "journal_entries"("id")   ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "payment_vouchers_reversal_je_id_fkey"      FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "journal_entries"("id")   ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "payment_vouchers_created_by_fkey"          FOREIGN KEY ("created_by")                REFERENCES "users"("id")             ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "payment_vouchers_posted_by_fkey"           FOREIGN KEY ("posted_by")                 REFERENCES "users"("id")             ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "payment_vouchers_reversed_by_fkey"         FOREIGN KEY ("reversed_by")               REFERENCES "users"("id")             ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX "payment_vouchers_supplier_id_idx"         ON "payment_vouchers"("supplier_id");
CREATE INDEX "payment_vouchers_treasury_account_id_idx" ON "payment_vouchers"("treasury_account_id");
CREATE INDEX "payment_vouchers_status_idx"              ON "payment_vouchers"("status");
CREATE INDEX "payment_vouchers_period_id_idx"           ON "payment_vouchers"("period_id");
CREATE INDEX "payment_vouchers_branch_id_voucher_date_idx" ON "payment_vouchers"("branch_id", "voucher_date" DESC);

-- ── receipt_voucher_allocations ──────────────────────────────────────
CREATE TABLE "receipt_voucher_allocations" (
  "id"                 UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  "receipt_voucher_id" UUID           NOT NULL,
  "sales_invoice_id"   UUID           NOT NULL,
  "amount"             DECIMAL(18,2)  NOT NULL,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "receipt_voucher_allocations_receipt_voucher_id_sales_invoice_id_key" UNIQUE ("receipt_voucher_id", "sales_invoice_id"),
  CONSTRAINT "receipt_voucher_allocations_receipt_voucher_id_fkey" FOREIGN KEY ("receipt_voucher_id") REFERENCES "receipt_vouchers"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "receipt_voucher_allocations_sales_invoice_id_fkey"   FOREIGN KEY ("sales_invoice_id")   REFERENCES "sales_invoices"("id")  ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX "receipt_voucher_allocations_receipt_voucher_id_idx" ON "receipt_voucher_allocations"("receipt_voucher_id");
CREATE INDEX "receipt_voucher_allocations_sales_invoice_id_idx"   ON "receipt_voucher_allocations"("sales_invoice_id");

-- ── payment_voucher_allocations ──────────────────────────────────────
CREATE TABLE "payment_voucher_allocations" (
  "id"                  UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  "payment_voucher_id"  UUID           NOT NULL,
  "purchase_invoice_id" UUID           NOT NULL,
  "amount"              DECIMAL(18,2)  NOT NULL,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_voucher_allocations_payment_voucher_id_purchase_invoice_id_key" UNIQUE ("payment_voucher_id", "purchase_invoice_id"),
  CONSTRAINT "payment_voucher_allocations_payment_voucher_id_fkey"  FOREIGN KEY ("payment_voucher_id")  REFERENCES "payment_vouchers"("id")  ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "payment_voucher_allocations_purchase_invoice_id_fkey" FOREIGN KEY ("purchase_invoice_id") REFERENCES "purchase_invoices"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX "payment_voucher_allocations_payment_voucher_id_idx"  ON "payment_voucher_allocations"("payment_voucher_id");
CREATE INDEX "payment_voucher_allocations_purchase_invoice_id_idx" ON "payment_voucher_allocations"("purchase_invoice_id");
