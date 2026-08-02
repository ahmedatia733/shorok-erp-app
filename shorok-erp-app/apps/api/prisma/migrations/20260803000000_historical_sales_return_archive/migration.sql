-- Historical sales-return archive. ADDITIVE ONLY: three new tables. No existing
-- column is altered or dropped and no existing row is rewritten, so rollback is
-- a plain DROP TABLE of the three new tables in reverse dependency order.
--
-- WHY THIS IS NOT A SalesReturn
--
-- Six July 2026 rows describe returns whose original invoices predate this
-- database and therefore do not exist in it. Their customer effect is already
-- inside the approved 2026-08-01 opening AR, and their stock effect is already
-- inside the 2026-08-01 physical count. Recording them as operational returns
-- would post them a second time and double-count both.
--
-- `sales_returns` also cannot hold them: `original_sales_invoice_id` is NOT NULL
-- and points at invoices that do not exist, and every status in that table is
-- on a path that eventually posts.
--
-- So these tables record history and nothing else. The contract is the ABSENCE
-- of posting columns: no journal_entry_id, no customer_transaction_id, no
-- inventory linkage, no status, no confirm/cancel. Nothing can post what it has
-- no column to reference.
--
-- IMMUTABILITY IS ENFORCED IN THE DATABASE, NOT BY CONVENTION.
-- 20260503103204_append_only_grants set ALTER DEFAULT PRIVILEGES granting
-- UPDATE and DELETE on every future table to `shorok_app`, so these tables
-- would be freely mutable by the application unless that is taken back. It is,
-- at the end of this migration.

CREATE TABLE IF NOT EXISTS "historical_return_import_batches" (
  "id"               UUID PRIMARY KEY,
  "batch_key"        VARCHAR(120) NOT NULL,
  "source_system"    VARCHAR(120) NOT NULL,
  "source_file_hash" VARCHAR(64)  NOT NULL,
  "source_sheet"     VARCHAR(120) NOT NULL,
  "expected_rows"    INTEGER      NOT NULL,
  "imported_rows"    INTEGER      NOT NULL DEFAULT 0,
  "status"           VARCHAR(20)  NOT NULL,
  "operator"         VARCHAR(120) NOT NULL,
  "approver"         VARCHAR(120) NOT NULL,
  "approval_date"    DATE         NOT NULL,
  "reconciliation"   JSONB,
  "code_revision"    VARCHAR(60),
  "importer_version" VARCHAR(20)  NOT NULL,
  "started_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "finished_at"      TIMESTAMPTZ(6)
);

CREATE UNIQUE INDEX IF NOT EXISTS "historical_return_import_batches_batch_key_key"
  ON "historical_return_import_batches" ("batch_key");
CREATE INDEX IF NOT EXISTS "historical_return_import_batches_status_idx"
  ON "historical_return_import_batches" ("status");

CREATE TABLE IF NOT EXISTS "historical_sales_return_archives" (
  "id"                         UUID PRIMARY KEY,
  "archive_number"             BIGSERIAL    NOT NULL,
  -- The duplicate gate. A repeated import of the same source row fails on this
  -- constraint rather than relying on the importer remembering to check.
  "source_fingerprint"         VARCHAR(64)  NOT NULL,
  "import_batch_id"            UUID         NOT NULL,
  "source_system"              VARCHAR(120) NOT NULL,
  "source_file_hash"           VARCHAR(64)  NOT NULL,
  "source_sheet"               VARCHAR(120) NOT NULL,
  "source_row"                 INTEGER      NOT NULL,
  "source_reference"           VARCHAR(160) NOT NULL,
  "document_date"              DATE         NOT NULL,
  -- Nullable on purpose: set only when the source name resolves to exactly one
  -- customer. A guess here would be worse than a null.
  "customer_id"                UUID,
  "customer_source_reference"  VARCHAR(200) NOT NULL,
  "original_invoice_reference" VARCHAR(120),
  "gross_value"                DECIMAL(14,2) NOT NULL,
  "notes"                      VARCHAR(1000),
  "immutable"                  BOOLEAN      NOT NULL DEFAULT true,
  "imported_by"                UUID         NOT NULL,
  "imported_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at"                 TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "historical_sales_return_archives_import_batch_id_fkey"
    FOREIGN KEY ("import_batch_id") REFERENCES "historical_return_import_batches"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "historical_sales_return_archives_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "historical_sales_return_archives_imported_by_fkey"
    FOREIGN KEY ("imported_by") REFERENCES "users"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "historical_sales_return_archives_archive_number_key"
  ON "historical_sales_return_archives" ("archive_number");
CREATE UNIQUE INDEX IF NOT EXISTS "historical_sales_return_archives_source_fingerprint_key"
  ON "historical_sales_return_archives" ("source_fingerprint");
CREATE INDEX IF NOT EXISTS "historical_sales_return_archives_import_batch_id_idx"
  ON "historical_sales_return_archives" ("import_batch_id");
CREATE INDEX IF NOT EXISTS "historical_sales_return_archives_customer_id_idx"
  ON "historical_sales_return_archives" ("customer_id");
CREATE INDEX IF NOT EXISTS "historical_sales_return_archives_document_date_idx"
  ON "historical_sales_return_archives" ("document_date" DESC);

CREATE TABLE IF NOT EXISTS "historical_sales_return_archive_lines" (
  "id"                   UUID PRIMARY KEY,
  "historical_return_id" UUID         NOT NULL,
  "line_number"          INTEGER      NOT NULL,
  -- Nullable for the same reason as customer_id: an exact code + exact board
  -- size match, or nothing.
  "product_variant_id"   UUID,
  "product_source_code"  VARCHAR(60)  NOT NULL,
  "boards"               DECIMAL(14,4) NOT NULL,
  "canonical_meters"     DECIMAL(14,4) NOT NULL,
  "unit_price"           DECIMAL(14,2),
  "line_value"           DECIMAL(14,2) NOT NULL,
  "source_reference"     VARCHAR(160) NOT NULL,
  CONSTRAINT "historical_sales_return_archive_lines_historical_return_id_fkey"
    FOREIGN KEY ("historical_return_id") REFERENCES "historical_sales_return_archives"("id")
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "historical_sales_return_archive_lines_product_variant_id_fkey"
    FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "historical_sales_return_archive_lines_return_line_key"
  ON "historical_sales_return_archive_lines" ("historical_return_id", "line_number");
CREATE INDEX IF NOT EXISTS "historical_sales_return_archive_lines_historical_return_id_idx"
  ON "historical_sales_return_archive_lines" ("historical_return_id");
CREATE INDEX IF NOT EXISTS "historical_sales_return_archive_lines_product_variant_id_idx"
  ON "historical_sales_return_archive_lines" ("product_variant_id");

-- Immutability. The archive is written once by a one-time importer running as
-- the migration owner, then read forever. Taking UPDATE and DELETE away from
-- the application role means a bug, a future endpoint or a stray Prisma call
-- cannot rewrite history — the database refuses it.
--
-- The batch header is exempt from the REVOKE because the importer legitimately
-- stamps imported_rows / status / finished_at / reconciliation on it when the
-- run completes. The archive rows themselves are never touched again.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shorok_app') THEN
    REVOKE UPDATE, DELETE ON "historical_sales_return_archives"      FROM "shorok_app";
    REVOKE UPDATE, DELETE ON "historical_sales_return_archive_lines" FROM "shorok_app";
  END IF;
END
$$;
