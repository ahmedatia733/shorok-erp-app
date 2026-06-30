-- Add sequential entry number, entry type, and reference to journal_entries

CREATE SEQUENCE IF NOT EXISTS "journal_entries_entry_number_seq" START 1;

ALTER TABLE "journal_entries"
  ADD COLUMN "entry_number" BIGINT NOT NULL DEFAULT nextval('"journal_entries_entry_number_seq"'),
  ADD COLUMN "entry_type"   VARCHAR(30) NOT NULL DEFAULT 'JOURNAL',
  ADD COLUMN "reference"    VARCHAR(100);

ALTER SEQUENCE "journal_entries_entry_number_seq"
  OWNED BY "journal_entries"."entry_number";

ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_entry_number_key" UNIQUE ("entry_number");
