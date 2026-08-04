-- Confirmed-invoice revision (P7).
--
-- Strictly additive and safe on live data: three new nullable/defaulted columns
-- on each invoice header, one new enum, two new tables. Nothing existing is
-- dropped, renamed or redefined, so the currently deployed application keeps
-- working unchanged while this migration is in flight and afterwards.
--
-- revision_number defaults to 1 = "the original confirmation, never revised".
-- Postgres 11+ stores a constant DEFAULT in the catalogue rather than rewriting
-- the table, so ADD COLUMN ... DEFAULT 1 NOT NULL is O(1) here and needs no
-- separate bounded backfill. The other two columns are plain nullable adds.

-- ── 1. Invoice headers ────────────────────────────────────────────────────
ALTER TABLE "sales_invoices"
  ADD COLUMN IF NOT EXISTS "revision_number"  INTEGER      NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "last_revised_at"  TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_revised_by"  UUID;

ALTER TABLE "purchase_invoices"
  ADD COLUMN IF NOT EXISTS "revision_number"  INTEGER      NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "last_revised_at"  TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_revised_by"  UUID;

-- A revision number below 1 is meaningless. NOT VALID keeps the ALTER from
-- scanning the live table; the rows written above are all exactly 1, and the
-- constraint is validated immediately after in its own (share-lock) step.
--
-- Every catalogue lookup in this file is scoped to the schema being migrated.
-- `conname` and `typname` are unique per SCHEMA, not per cluster, so an
-- unqualified existence check finds another schema's object and wrongly skips
-- the creation — which is exactly what happens when the test harness applies
-- this migration into a fresh schema alongside earlier ones.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sales_invoices_revision_number_check' AND conrelid = 'sales_invoices'::regclass
  ) THEN
    ALTER TABLE "sales_invoices"
      ADD CONSTRAINT "sales_invoices_revision_number_check" CHECK ("revision_number" >= 1) NOT VALID;
    ALTER TABLE "sales_invoices" VALIDATE CONSTRAINT "sales_invoices_revision_number_check";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'purchase_invoices_revision_number_check' AND conrelid = 'purchase_invoices'::regclass
  ) THEN
    ALTER TABLE "purchase_invoices"
      ADD CONSTRAINT "purchase_invoices_revision_number_check" CHECK ("revision_number" >= 1) NOT VALID;
    ALTER TABLE "purchase_invoices" VALIDATE CONSTRAINT "purchase_invoices_revision_number_check";
  END IF;
END
$$;

-- ── 2. Revision status ────────────────────────────────────────────────────
-- Only POSTED can ever reach the table: a preview writes nothing at all and a
-- failed revision rolls its whole transaction back. The other two members exist
-- so the response contract and any future durable attempt log share one type.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'InvoiceRevisionStatus' AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE "InvoiceRevisionStatus" AS ENUM ('PREVIEWED', 'POSTED', 'FAILED');
  END IF;
END
$$;

-- ── 3. Sales invoice revisions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sales_invoice_revisions" (
  "id"                                UUID                    NOT NULL,
  "sales_invoice_id"                  UUID                    NOT NULL,
  "revision_number"                   INTEGER                 NOT NULL,
  "previous_revision_number"          INTEGER                 NOT NULL,
  "reason"                            VARCHAR(500)            NOT NULL,
  "status"                            "InvoiceRevisionStatus" NOT NULL DEFAULT 'POSTED',
  "original_invoice_status"           VARCHAR(20)             NOT NULL,
  "resulting_invoice_status"          VARCHAR(20)             NOT NULL,
  "previous_document_date"            DATE                    NOT NULL,
  "document_date"                     DATE                    NOT NULL,
  "posting_date"                      DATE                    NOT NULL,
  "crosses_closed_period"             BOOLEAN                 NOT NULL DEFAULT false,
  "before_snapshot"                   JSONB                   NOT NULL,
  "after_snapshot"                    JSONB                   NOT NULL,
  "delta"                             JSONB                   NOT NULL,
  "before_fingerprint"                VARCHAR(64)             NOT NULL,
  "after_fingerprint"                 VARCHAR(64)             NOT NULL,
  "preview_fingerprint"               VARCHAR(64)             NOT NULL,
  "idempotency_key"                   VARCHAR(120)            NOT NULL,
  "reversal_journal_entry_id"         UUID,
  "reversal_cogs_journal_entry_id"    UUID,
  "replacement_journal_entry_id"      UUID,
  "replacement_cogs_journal_entry_id" UUID,
  "valuation_journal_entry_ids"       JSONB                   NOT NULL,
  "reversal_movement_ids"             JSONB                   NOT NULL,
  "replacement_movement_ids"          JSONB                   NOT NULL,
  "reversal_party_tx_ids"             JSONB                   NOT NULL,
  "replacement_party_tx_ids"          JSONB                   NOT NULL,
  "revised_by"                        UUID                    NOT NULL,
  "created_at"                        TIMESTAMPTZ(6)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sales_invoice_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sales_invoice_revisions_revision_number_check" CHECK ("revision_number" >= 2),
  CONSTRAINT "sales_invoice_revisions_sequence_check" CHECK ("revision_number" = "previous_revision_number" + 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS "sales_invoice_revisions_invoice_revision_key"
  ON "sales_invoice_revisions" ("sales_invoice_id", "revision_number");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_invoice_revisions_invoice_idem_key"
  ON "sales_invoice_revisions" ("sales_invoice_id", "idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_invoice_revisions_idempotency_key_key"
  ON "sales_invoice_revisions" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "sales_invoice_revisions_sales_invoice_id_idx"
  ON "sales_invoice_revisions" ("sales_invoice_id");
CREATE INDEX IF NOT EXISTS "sales_invoice_revisions_status_idx"
  ON "sales_invoice_revisions" ("status");
CREATE INDEX IF NOT EXISTS "sales_invoice_revisions_revised_by_created_at_idx"
  ON "sales_invoice_revisions" ("revised_by", "created_at" DESC);

-- ── 4. Purchase invoice revisions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "purchase_invoice_revisions" (
  "id"                           UUID                    NOT NULL,
  "purchase_invoice_id"          UUID                    NOT NULL,
  "revision_number"              INTEGER                 NOT NULL,
  "previous_revision_number"     INTEGER                 NOT NULL,
  "reason"                       VARCHAR(500)            NOT NULL,
  "status"                       "InvoiceRevisionStatus" NOT NULL DEFAULT 'POSTED',
  "original_invoice_status"      VARCHAR(20)             NOT NULL,
  "resulting_invoice_status"     VARCHAR(20)             NOT NULL,
  "previous_document_date"       DATE                    NOT NULL,
  "document_date"                DATE                    NOT NULL,
  "posting_date"                 DATE                    NOT NULL,
  "crosses_closed_period"        BOOLEAN                 NOT NULL DEFAULT false,
  "before_snapshot"              JSONB                   NOT NULL,
  "after_snapshot"               JSONB                   NOT NULL,
  "delta"                        JSONB                   NOT NULL,
  "before_fingerprint"           VARCHAR(64)             NOT NULL,
  "after_fingerprint"            VARCHAR(64)             NOT NULL,
  "preview_fingerprint"          VARCHAR(64)             NOT NULL,
  "idempotency_key"              VARCHAR(120)            NOT NULL,
  "reversal_journal_entry_id"    UUID,
  "replacement_journal_entry_id" UUID,
  "valuation_journal_entry_ids"  JSONB                   NOT NULL,
  "reversal_movement_ids"        JSONB                   NOT NULL,
  "replacement_movement_ids"     JSONB                   NOT NULL,
  "reversal_party_tx_ids"        JSONB                   NOT NULL,
  "replacement_party_tx_ids"     JSONB                   NOT NULL,
  "revised_by"                   UUID                    NOT NULL,
  "created_at"                   TIMESTAMPTZ(6)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "purchase_invoice_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "purchase_invoice_revisions_revision_number_check" CHECK ("revision_number" >= 2),
  CONSTRAINT "purchase_invoice_revisions_sequence_check" CHECK ("revision_number" = "previous_revision_number" + 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS "purchase_invoice_revisions_invoice_revision_key"
  ON "purchase_invoice_revisions" ("purchase_invoice_id", "revision_number");
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_invoice_revisions_invoice_idem_key"
  ON "purchase_invoice_revisions" ("purchase_invoice_id", "idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_invoice_revisions_idempotency_key_key"
  ON "purchase_invoice_revisions" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "purchase_invoice_revisions_purchase_invoice_id_idx"
  ON "purchase_invoice_revisions" ("purchase_invoice_id");
CREATE INDEX IF NOT EXISTS "purchase_invoice_revisions_status_idx"
  ON "purchase_invoice_revisions" ("status");
CREATE INDEX IF NOT EXISTS "purchase_invoice_revisions_revised_by_created_at_idx"
  ON "purchase_invoice_revisions" ("revised_by", "created_at" DESC);

-- ── 5. Foreign keys ───────────────────────────────────────────────────────
-- Both parents are tiny relative to the child (which starts empty), so the FK
-- validation scan here is trivial. Restrict on both: a revised invoice must not
-- be deletable while its history exists, and neither must its actor.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sales_invoice_revisions_sales_invoice_id_fkey'
      AND conrelid = 'sales_invoice_revisions'::regclass
  ) THEN
    ALTER TABLE "sales_invoice_revisions"
      ADD CONSTRAINT "sales_invoice_revisions_sales_invoice_id_fkey"
      FOREIGN KEY ("sales_invoice_id") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sales_invoice_revisions_revised_by_fkey'
      AND conrelid = 'sales_invoice_revisions'::regclass
  ) THEN
    ALTER TABLE "sales_invoice_revisions"
      ADD CONSTRAINT "sales_invoice_revisions_revised_by_fkey"
      FOREIGN KEY ("revised_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'purchase_invoice_revisions_purchase_invoice_id_fkey'
      AND conrelid = 'purchase_invoice_revisions'::regclass
  ) THEN
    ALTER TABLE "purchase_invoice_revisions"
      ADD CONSTRAINT "purchase_invoice_revisions_purchase_invoice_id_fkey"
      FOREIGN KEY ("purchase_invoice_id") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'purchase_invoice_revisions_revised_by_fkey'
      AND conrelid = 'purchase_invoice_revisions'::regclass
  ) THEN
    ALTER TABLE "purchase_invoice_revisions"
      ADD CONSTRAINT "purchase_invoice_revisions_revised_by_fkey"
      FOREIGN KEY ("revised_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- ── 6. Immutability of the audit spine ────────────────────────────────────
-- A revision row is written once, inside the same transaction as the effects it
-- describes, and then only ever read. The earlier append-only-grants migration
-- hands the application role DML on every future table by default, so take the
-- rewrite rights back explicitly — the database, not a code review, is what
-- guarantees a revision record can never be edited or erased afterwards.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shorok_app') THEN
    REVOKE UPDATE, DELETE ON "sales_invoice_revisions"    FROM "shorok_app";
    REVOKE UPDATE, DELETE ON "purchase_invoice_revisions" FROM "shorok_app";
  END IF;
END
$$;
