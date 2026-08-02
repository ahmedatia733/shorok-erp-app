-- Cutover import provenance. ADDITIVE ONLY: two new tables, no column is
-- altered or dropped, no existing row is rewritten. Rollback is a plain
-- DROP TABLE of the two new tables (see the phase report).
--
-- These tables record WHAT an opening-data import did so that a repeated
-- execute can be refused and every created entity traced to its approved
-- source row. They deliberately store NO source document, customer name,
-- phone number or per-row balance.

CREATE TABLE IF NOT EXISTS "cutover_import_batches" (
  "id"               UUID PRIMARY KEY,
  "manifest_id"      VARCHAR(120) NOT NULL,
  "manifest_hash"    VARCHAR(64)  NOT NULL,
  "source_hashes"    JSONB        NOT NULL,
  "mode"             VARCHAR(20)  NOT NULL,
  "scope"            VARCHAR(40)  NOT NULL,
  "status"           VARCHAR(20)  NOT NULL,
  "operator"         VARCHAR(120) NOT NULL,
  "approver"         VARCHAR(120) NOT NULL,
  "approval_date"    DATE         NOT NULL,
  "cutover_date"     DATE         NOT NULL,
  "branch_id"        UUID         NOT NULL,
  "started_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "finished_at"      TIMESTAMPTZ(6),
  "failure_code"     VARCHAR(80),
  "failure_reason"   VARCHAR(500),
  "reconciliation"   JSONB,
  "code_revision"    VARCHAR(60),
  "importer_version" VARCHAR(20)  NOT NULL,
  CONSTRAINT "cutover_import_batches_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- One committed run per (manifest hash, scope, mode). A DRY_RUN always rolls
-- back, so it can never occupy the EXECUTE slot.
CREATE UNIQUE INDEX IF NOT EXISTS "cutover_import_batches_manifest_hash_scope_mode_key"
  ON "cutover_import_batches"("manifest_hash", "scope", "mode");
CREATE INDEX IF NOT EXISTS "cutover_import_batches_status_idx"
  ON "cutover_import_batches"("status");

CREATE TABLE IF NOT EXISTS "cutover_import_rows" (
  "id"               UUID PRIMARY KEY,
  "batch_id"         UUID         NOT NULL,
  "source_key"       VARCHAR(160) NOT NULL,
  "decision_id"      VARCHAR(60)  NOT NULL,
  "entity_type"      VARCHAR(40)  NOT NULL,
  "entity_id"        UUID,
  "action"           VARCHAR(30)  NOT NULL,
  "source_reference" VARCHAR(160) NOT NULL,
  "approved_key"     VARCHAR(160) NOT NULL,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "cutover_import_rows_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "cutover_import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "cutover_import_rows_batch_id_source_key_key"
  ON "cutover_import_rows"("batch_id", "source_key");
CREATE INDEX IF NOT EXISTS "cutover_import_rows_entity_type_entity_id_idx"
  ON "cutover_import_rows"("entity_type", "entity_id");
