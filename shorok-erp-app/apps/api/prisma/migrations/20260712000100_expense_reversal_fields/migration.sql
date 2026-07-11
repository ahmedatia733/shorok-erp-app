-- Phase 3D (commit 2): expense reversal-hardening (Option B — retain the row).
-- Additive only. status backfilled from journal_entry_id before it matters:
--   journal_entry_id NULL     → RECORDED (legacy / record-only, still deletable)
--   journal_entry_id NOT NULL → POSTED   (has a GL entry; reverse, never delete)

CREATE TYPE "ExpenseStatus" AS ENUM ('RECORDED', 'POSTED', 'REVERSED');

ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "status" "ExpenseStatus" NOT NULL DEFAULT 'RECORDED',
  ADD COLUMN IF NOT EXISTS "reversal_journal_entry_id" UUID;

-- Backfill existing rows: anything already carrying a GL entry is POSTED.
UPDATE "expenses" SET "status" = 'POSTED'
WHERE "journal_entry_id" IS NOT NULL AND "status" = 'RECORDED';

-- Nullable FK to the reversal entry (no data migration; existing rows stay NULL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_reversal_journal_entry_id_fkey') THEN
    ALTER TABLE "expenses"
      ADD CONSTRAINT "expenses_reversal_journal_entry_id_fkey"
      FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "journal_entries"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
