-- Multi-treasury: additive management layer over existing cash/bank GL accounts.
-- Purely additive — creates two new tables + two enum values + one enum type,
-- and backfills a Treasury row for every EXISTING cash/bank leaf account (incl.
-- the current main treasury) WITHOUT touching any journal line or account row.
-- Rollback: DROP TABLE "treasury_transfers"; DROP TABLE "treasuries";
--           DROP TYPE "TransferStatus"; (the two enum values are harmless if left).

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- AlterEnum (additive — safe; values are only referenced at runtime)
ALTER TYPE "JournalSourceType" ADD VALUE IF NOT EXISTS 'TREASURY_TRANSFER';
ALTER TYPE "JournalSourceType" ADD VALUE IF NOT EXISTS 'TREASURY_OPENING';

-- CreateTable
CREATE TABLE "treasuries" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name_ar" VARCHAR(160) NOT NULL,
    "name_en" VARCHAR(160),
    "branch_id" UUID NOT NULL,
    "gl_account_id" UUID NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL DEFAULT 'EGP',
    "allow_negative_balance" BOOLEAN NOT NULL DEFAULT false,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "treasuries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_transfers" (
    "id" UUID NOT NULL,
    "transfer_number" BIGSERIAL NOT NULL,
    "transfer_date" DATE NOT NULL,
    "source_treasury_id" UUID NOT NULL,
    "destination_treasury_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reference" VARCHAR(100),
    "notes" VARCHAR(300),
    "status" "TransferStatus" NOT NULL DEFAULT 'DRAFT',
    "period_id" UUID,
    "journal_entry_id" UUID,
    "reversal_journal_entry_id" UUID,
    "created_by" UUID NOT NULL,
    "confirmed_by" UUID,
    "cancelled_by" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "treasury_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "treasuries_code_key" ON "treasuries"("code");
CREATE UNIQUE INDEX "treasuries_gl_account_id_key" ON "treasuries"("gl_account_id");
CREATE INDEX "treasuries_branch_id_idx" ON "treasuries"("branch_id");
CREATE INDEX "treasuries_active_idx" ON "treasuries"("active");
-- At most ONE default treasury company-wide.
CREATE UNIQUE INDEX "treasuries_one_default_key" ON "treasuries"("is_default") WHERE "is_default" = true;

-- CreateIndex
CREATE UNIQUE INDEX "treasury_transfers_transfer_number_key" ON "treasury_transfers"("transfer_number");
CREATE UNIQUE INDEX "treasury_transfers_journal_entry_id_key" ON "treasury_transfers"("journal_entry_id");
CREATE UNIQUE INDEX "treasury_transfers_reversal_journal_entry_id_key" ON "treasury_transfers"("reversal_journal_entry_id");
CREATE INDEX "treasury_transfers_source_treasury_id_idx" ON "treasury_transfers"("source_treasury_id");
CREATE INDEX "treasury_transfers_destination_treasury_id_idx" ON "treasury_transfers"("destination_treasury_id");
CREATE INDEX "treasury_transfers_status_idx" ON "treasury_transfers"("status");

-- AddForeignKey
ALTER TABLE "treasuries" ADD CONSTRAINT "treasuries_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasuries" ADD CONSTRAINT "treasuries_gl_account_id_fkey" FOREIGN KEY ("gl_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasuries" ADD CONSTRAINT "treasuries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_source_treasury_id_fkey" FOREIGN KEY ("source_treasury_id") REFERENCES "treasuries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_destination_treasury_id_fkey" FOREIGN KEY ("destination_treasury_id") REFERENCES "treasuries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "financial_periods"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_reversal_journal_entry_id_fkey" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: wrap EVERY existing cash/bank leaf account in a Treasury row so the
-- current main treasury and all historical cash accounts remain fully usable.
-- No journal line is touched; the GL account stays the balance source of truth.
-- Skipped entirely on a fresh DB with no branch/owner yet (tests seed their own).
-- The lowest-code cash/bank account becomes the single default treasury.
INSERT INTO "treasuries" (
  "id", "code", "name_ar", "name_en", "branch_id", "gl_account_id",
  "currency_code", "allow_negative_balance", "is_default", "active",
  "notes", "created_by", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  a."code",
  a."name_ar",
  a."name_en",
  (SELECT id FROM "branches" WHERE active = true ORDER BY created_at ASC LIMIT 1),
  a."id",
  'EGP',
  false,
  (a."id" = (
    SELECT a2."id" FROM "accounts" a2
    WHERE a2."is_cash_or_bank" = true AND a2."treasury_type" IN ('CASH','BANK')
      AND a2."is_leaf" = true AND a2."active" = true
    ORDER BY a2."code" ASC LIMIT 1
  )),
  a."active",
  'Backfilled from existing cash/bank account by the multi-treasury migration.',
  (SELECT id FROM "users" WHERE role = 'OWNER' ORDER BY created_at ASC LIMIT 1),
  now(),
  now()
FROM "accounts" a
WHERE a."is_cash_or_bank" = true
  AND a."treasury_type" IN ('CASH','BANK')
  AND a."is_leaf" = true
  AND NOT EXISTS (SELECT 1 FROM "treasuries" t WHERE t."gl_account_id" = a."id")
  AND EXISTS (SELECT 1 FROM "branches" WHERE active = true)
  AND EXISTS (SELECT 1 FROM "users" WHERE role = 'OWNER');
