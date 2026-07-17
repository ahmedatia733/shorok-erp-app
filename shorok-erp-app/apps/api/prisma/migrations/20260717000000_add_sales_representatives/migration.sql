-- Sales Representatives (ADDITIVE ONLY).
-- One new master-data table plus a nullable sales_representative_id dimension on
-- sales_invoices, journal_entries and journal_lines. The authoritative rep
-- balance is read from journal_lines only; the header columns are attribution.
-- No existing column/constraint is altered or dropped; existing rows keep NULL.

-- ── sales_representatives ────────────────────────────────────────────
CREATE TABLE "sales_representatives" (
  "id"         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"       VARCHAR(20)   NOT NULL,
  "name_ar"    VARCHAR(200)  NOT NULL,
  "name_en"    VARCHAR(200),
  "phone"      VARCHAR(30),
  "address"    VARCHAR(300),
  "notes"      VARCHAR(1000),
  "active"     BOOLEAN       NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL
);

CREATE UNIQUE INDEX "sales_representatives_code_key" ON "sales_representatives"("code");
CREATE INDEX "sales_representatives_active_idx" ON "sales_representatives"("active");

-- ── nullable dimension columns on existing tables ────────────────────
ALTER TABLE "sales_invoices"  ADD COLUMN "sales_representative_id" UUID;
ALTER TABLE "journal_entries" ADD COLUMN "sales_representative_id" UUID;
ALTER TABLE "journal_lines"   ADD COLUMN "sales_representative_id" UUID;

CREATE INDEX "sales_invoices_sales_representative_id_idx"  ON "sales_invoices"("sales_representative_id");
CREATE INDEX "journal_entries_sales_representative_id_idx" ON "journal_entries"("sales_representative_id");
CREATE INDEX "journal_lines_sales_representative_id_idx"   ON "journal_lines"("sales_representative_id");

-- ── foreign keys (RESTRICT delete: a rep with history is never removed) ─
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT "sales_invoices_sales_representative_id_fkey"
  FOREIGN KEY ("sales_representative_id") REFERENCES "sales_representatives"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_sales_representative_id_fkey"
  FOREIGN KEY ("sales_representative_id") REFERENCES "sales_representatives"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_sales_representative_id_fkey"
  FOREIGN KEY ("sales_representative_id") REFERENCES "sales_representatives"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
