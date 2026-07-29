-- ============================================================================
-- TREASURY BACKFILL PREFLIGHT (read-only) — run BEFORE any future PRODUCTION
-- deploy of the multi-treasury feature. It writes NOTHING.
--
-- WHY: the applied local migration `20260727000000_multi_treasury` backfills a
-- Treasury row for every existing cash/bank leaf account and assigns them to the
-- FIRST active branch. That is deterministic and safe when EXACTLY ONE active
-- branch exists, but AMBIGUOUS when there are several (a cash account has no
-- branch column, so its true owning branch cannot be derived).
--
-- SAFE PRODUCTION PROCEDURE:
--   1. Run this preflight against the production database (read-only).
--   2. If "active_branches" = 1  → the automatic backfill is safe; deploy as-is.
--   3. If "active_branches" > 1  → DO NOT rely on the automatic first-branch
--      backfill. Instead: (a) confirm the mapping below with the finance owner,
--      (b) provide an explicit gl_account_id → branch_id mapping seed, and
--      (c) run the mapped backfill (see mapped-backfill template at the bottom)
--      INSTEAD of the blind INSERT. Do NOT edit the already-applied migration
--      file (it would break the Prisma checksum in environments that already
--      ran it); add the mapped backfill as a NEW migration/seed guarded to only
--      touch cash accounts not yet wrapped by a Treasury.
--   4. Never rewrite historical journal lines — the GL stays the source of truth.
-- ============================================================================

-- (a) How many active branches? (1 ⇒ auto-backfill safe.)
SELECT count(*) AS active_branches FROM branches WHERE active = true;

-- (b) Reconciliation report: one row per cash/bank leaf account with its current
--     GL balance and the PROPOSED treasury mapping. branchId is 'AMBIGUOUS'
--     whenever more than one active branch exists (needs an explicit mapping).
SELECT
  a.id                                AS gl_account_id,
  a.code                              AS account_code,
  a.name_ar                           AS account_name,
  a.treasury_type                     AS treasury_type,
  COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl WHERE jl.account_id = a.id), 0) AS current_gl_balance,
  a.code                              AS proposed_treasury_code,
  CASE
    WHEN (SELECT count(*) FROM branches WHERE active = true) = 1
      THEN (SELECT id::text FROM branches WHERE active = true ORDER BY created_at ASC LIMIT 1)
    ELSE 'AMBIGUOUS'
  END                                 AS proposed_branch_id,
  EXISTS (SELECT 1 FROM treasuries t WHERE t.gl_account_id = a.id) AS already_wrapped
FROM accounts a
WHERE a.is_cash_or_bank = true
  AND a.treasury_type IN ('CASH','BANK')
  AND a.is_leaf = true
ORDER BY a.code;

-- ----------------------------------------------------------------------------
-- MAPPED-BACKFILL TEMPLATE (multi-branch production only) — fill in real ids,
-- run as a NEW guarded migration. Never touches accounts already wrapped.
--
-- INSERT INTO treasuries (id, code, name_ar, name_en, branch_id, gl_account_id,
--   currency_code, allow_negative_balance, is_default, active, created_by,
--   created_at, updated_at)
-- VALUES
--   (gen_random_uuid(), '<code>', '<name_ar>', NULL, '<branch_uuid>',
--    '<gl_account_uuid>', 'EGP', false, false, true, '<owner_uuid>', now(), now())
-- ON CONFLICT (gl_account_id) DO NOTHING;
-- ----------------------------------------------------------------------------
