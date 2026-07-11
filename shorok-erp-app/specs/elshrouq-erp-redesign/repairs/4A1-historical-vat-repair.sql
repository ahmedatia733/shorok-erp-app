-- =====================================================================
-- Phase 4A-1 — Historical unbalanced purchase journal-entry repair
-- =====================================================================
-- One-time DATA repair. Additive only: INSERTs the missing input-VAT debit
-- leg into two legacy purchase entries whose original confirm omitted it
-- (tax_account_id was NULL at legacy posting time). NO existing line is edited
-- or deleted. NOT a Prisma migration — run MANUALLY, never auto-runs on deploy.
--
-- Verified facts (2026-07-11):
--   Entry #7  7c5301d1-48ad-4b02-9704-cb0ff79a299b  PI-2026-0009  CONFIRMED
--     current: Dr Inventory(1250) 20,475.00 / Cr AP(2100) 20,491.38  → gap 16.38
--     invoice: subtotal 20,475.00, tax_amount 16.38 (line tax_rate 0.08%), grand 20,491.38
--     → missing Dr VAT-Input 16.38
--   Entry #8  1117f5dd-594f-4403-8bba-a343d44d1551  PI-2026-0010  CONFIRMED
--     current: Dr Inventory(1250) 2,178,750.00 / Cr AP(2100) 2,483,775.00 → gap 305,025.00
--     invoice: subtotal 2,178,750.00, tax_amount 305,025.00 (two 14% lines), grand 2,483,775.00
--     → missing Dr VAT-Input 305,025.00
--   VAT-Input account: 70f18bc7-1583-4298-a80b-4d56cafde805 (code 2300, leaf, active,
--     = PostingProfile.vat_input_account; no VAT_INPUT system-role account exists)
--
-- Idempotent & guarded: aborts (RAISE) if entries are missing, if a gap does not
-- match the expected amount, if a VAT line already exists on either entry, or if
-- the global unbalanced count is not 0 afterward. Safe to re-run (no double-insert).
--
-- Rollback: DELETE FROM journal_lines WHERE note LIKE 'Phase 4A-1 repair:%';
--           DELETE FROM audit_logs   WHERE after_snapshot->>'repair' = 'insert_vat_input_leg';
--           (or restore the pre-repair backup).
-- =====================================================================

BEGIN;

DO $$
DECLARE
  v_vat_account uuid := '70f18bc7-1583-4298-a80b-4d56cafde805';
  v_e7          uuid := '7c5301d1-48ad-4b02-9704-cb0ff79a299b';
  v_e8          uuid := '1117f5dd-594f-4403-8bba-a343d44d1551';
  v_e7_gap      numeric(14,2) := 16.38;
  v_e8_gap      numeric(14,2) := 305025.00;
  v_owner       uuid;
  v_line7       uuid;
  v_line8       uuid;
  v_gap         numeric(14,2);
  v_unbalanced  int;
BEGIN
  -- Lock target entries.
  PERFORM 1 FROM journal_entries WHERE id IN (v_e7, v_e8) FOR UPDATE;

  IF (SELECT count(*) FROM journal_entries WHERE id IN (v_e7, v_e8)) <> 2 THEN
    RAISE EXCEPTION 'Repair aborted: one or both target entries not found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = v_vat_account AND is_leaf AND active) THEN
    RAISE EXCEPTION 'Repair aborted: VAT account % is not a postable leaf/active account', v_vat_account;
  END IF;

  -- Idempotency guard: never insert a second VAT line onto these entries.
  IF EXISTS (SELECT 1 FROM journal_lines WHERE journal_entry_id IN (v_e7, v_e8) AND account_id = v_vat_account) THEN
    RAISE EXCEPTION 'Repair aborted: a VAT line already exists on a target entry (already repaired?)';
  END IF;

  v_owner := (SELECT id FROM users WHERE phone = '+201000000000' LIMIT 1);

  -- ── Entry #7 (PI-2026-0009) ──────────────────────────────────────────
  SELECT COALESCE(SUM(credit),0) - COALESCE(SUM(debit),0) INTO v_gap
    FROM journal_lines WHERE journal_entry_id = v_e7;
  IF v_gap <> v_e7_gap THEN
    RAISE EXCEPTION 'Repair aborted: entry #7 gap % <> expected %', v_gap, v_e7_gap;
  END IF;
  INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, note)
  VALUES (gen_random_uuid(), v_e7, v_vat_account, v_e7_gap, 0,
          'Phase 4A-1 repair: missing input VAT leg (PI-2026-0009)')
  RETURNING id INTO v_line7;

  -- ── Entry #8 (PI-2026-0010) ──────────────────────────────────────────
  SELECT COALESCE(SUM(credit),0) - COALESCE(SUM(debit),0) INTO v_gap
    FROM journal_lines WHERE journal_entry_id = v_e8;
  IF v_gap <> v_e8_gap THEN
    RAISE EXCEPTION 'Repair aborted: entry #8 gap % <> expected %', v_gap, v_e8_gap;
  END IF;
  INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, note)
  VALUES (gen_random_uuid(), v_e8, v_vat_account, v_e8_gap, 0,
          'Phase 4A-1 repair: missing input VAT leg (PI-2026-0010)')
  RETURNING id INTO v_line8;

  -- Per-entry re-verification.
  IF (SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) FROM journal_lines WHERE journal_entry_id = v_e7) <> 0 THEN
    RAISE EXCEPTION 'Repair aborted: entry #7 still unbalanced after insert';
  END IF;
  IF (SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) FROM journal_lines WHERE journal_entry_id = v_e8) <> 0 THEN
    RAISE EXCEPTION 'Repair aborted: entry #8 still unbalanced after insert';
  END IF;

  -- Global re-verification: no unbalanced entries remain.
  SELECT count(*) INTO v_unbalanced FROM (
    SELECT je.id FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id = je.id
    GROUP BY je.id HAVING COALESCE(SUM(jl.debit),0) <> COALESCE(SUM(jl.credit),0)
  ) t;
  IF v_unbalanced <> 0 THEN
    RAISE EXCEPTION 'Repair aborted: % unbalanced entries remain (expected 0)', v_unbalanced;
  END IF;

  -- Audit evidence (one row per repaired entry).
  INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id,
                          before_snapshot, after_snapshot,
                          human_readable_summary_ar, human_readable_summary_en)
  VALUES
   (gen_random_uuid(), v_owner, 'UPDATE'::"AuditAction", 'journal_entry', v_e7,
    jsonb_build_object('status','unbalanced','gap', v_e7_gap),
    jsonb_build_object('repair','insert_vat_input_leg','line_id', v_line7, 'account', v_vat_account, 'debit', v_e7_gap),
    'إصلاح 4A-1: إضافة سطر ضريبة القيمة المضافة المدخلة الناقص للقيد رقم 7 (PI-2026-0009)',
    'Phase 4A-1 repair: inserted missing input-VAT debit leg on entry #7 (PI-2026-0009)'),
   (gen_random_uuid(), v_owner, 'UPDATE'::"AuditAction", 'journal_entry', v_e8,
    jsonb_build_object('status','unbalanced','gap', v_e8_gap),
    jsonb_build_object('repair','insert_vat_input_leg','line_id', v_line8, 'account', v_vat_account, 'debit', v_e8_gap),
    'إصلاح 4A-1: إضافة سطر ضريبة القيمة المضافة المدخلة الناقص للقيد رقم 8 (PI-2026-0010)',
    'Phase 4A-1 repair: inserted missing input-VAT debit leg on entry #8 (PI-2026-0010)');

  RAISE NOTICE 'Phase 4A-1 repair OK — entry7 line %, entry8 line %, unbalanced now 0', v_line7, v_line8;
END $$;

COMMIT;
