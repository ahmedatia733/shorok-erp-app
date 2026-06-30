-- Migration: add_journal_templates
-- Creates two tables: journal_templates (header) and journal_template_lines (lines)

CREATE TABLE "journal_templates" (
  "id"          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"        VARCHAR(200)  NOT NULL,
  "description" VARCHAR(500),
  "active"      BOOLEAN       NOT NULL DEFAULT true,
  "created_by"  UUID          NOT NULL REFERENCES "users"("id"),
  "created_at"  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX "journal_templates_created_by_idx" ON "journal_templates"("created_by");

CREATE TABLE "journal_template_lines" (
  "id"          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_id" UUID          NOT NULL REFERENCES "journal_templates"("id") ON DELETE CASCADE,
  "account_id"  UUID          NOT NULL REFERENCES "accounts"("id"),
  "type"        VARCHAR(10)   NOT NULL CHECK ("type" IN ('debit','credit')),
  "amount"      DECIMAL(14,2),
  "note"        VARCHAR(300),
  "sort_order"  INT           NOT NULL DEFAULT 0
);
CREATE INDEX "journal_template_lines_template_idx" ON "journal_template_lines"("template_id");
