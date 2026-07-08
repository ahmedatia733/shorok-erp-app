-- Phase 2 accounting foundation — additive columns on journal_entries,
-- journal_lines, accounts. Every column is nullable or defaulted so the 8
-- existing direct-journal writers keep inserting with zero code change, and
-- the two historical unbalanced entries are left completely untouched.

-- ── journal_entries: status / period / reversal link / typed source / idem ──
ALTER TABLE "journal_entries"
  ADD COLUMN IF NOT EXISTS "status"          "JournalEntryStatus" NOT NULL DEFAULT 'POSTED',
  ADD COLUMN IF NOT EXISTS "period_id"       UUID REFERENCES "financial_periods"("id"),
  ADD COLUMN IF NOT EXISTS "reversal_of_id"  UUID REFERENCES "journal_entries"("id"),
  ADD COLUMN IF NOT EXISTS "source_type"     "JournalSourceType",
  ADD COLUMN IF NOT EXISTS "source_id"       UUID,
  ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(120);

-- Idempotency: at most one entry per key (partial unique — NULLs unconstrained
-- so legacy writers that omit the key are unaffected).
CREATE UNIQUE INDEX IF NOT EXISTS "journal_entries_idempotency_key_uq"
  ON "journal_entries" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "journal_entries_period_idx"      ON "journal_entries" ("period_id");
CREATE INDEX IF NOT EXISTS "journal_entries_source_idx"      ON "journal_entries" ("source_type", "source_id");
CREATE INDEX IF NOT EXISTS "journal_entries_entry_date_idx"  ON "journal_entries" ("entry_date");

-- ── journal_lines: party & branch dimensions ────────────────────────────────
ALTER TABLE "journal_lines"
  ADD COLUMN IF NOT EXISTS "party_type" "JournalPartyType",
  ADD COLUMN IF NOT EXISTS "party_id"   UUID,
  ADD COLUMN IF NOT EXISTS "branch_id"  UUID REFERENCES "branches"("id");

CREATE INDEX IF NOT EXISTS "journal_lines_account_party_idx"
  ON "journal_lines" ("account_id", "party_type", "party_id");

-- debit-XOR-credit: exactly one side non-zero. Added NOT VALID so it applies to
-- NEW rows only and does NOT retroactively validate existing rows (protects the
-- two historical unbalanced entries — Phase 4 reconciliation owns those).
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_debit_xor_credit_ck"
  CHECK (("debit" = 0) <> ("credit" = 0)) NOT VALID;

-- ── accounts: treasury flags & system-role tagging ──────────────────────────
ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "is_cash_or_bank" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "treasury_type"   "TreasuryType",
  ADD COLUMN IF NOT EXISTS "bank_meta"       JSONB,
  ADD COLUMN IF NOT EXISTS "system_role"     "AccountSystemRole";

-- A system role identifies a control account uniquely (at most one per role).
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_system_role_uq"
  ON "accounts" ("system_role")
  WHERE "system_role" IS NOT NULL;
