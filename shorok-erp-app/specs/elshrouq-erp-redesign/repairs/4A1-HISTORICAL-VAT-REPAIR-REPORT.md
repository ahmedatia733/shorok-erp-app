# Phase 4A-1 — Historical VAT Repair Report

**Date:** 2026-07-11
**Type:** One-time additive data repair (no schema change, no code change)
**Script:** [`4A1-historical-vat-repair.sql`](./4A1-historical-vat-repair.sql)

## Purpose

Two legacy purchase journal entries (created before Phase 3A) were internally
unbalanced because the original confirm omitted the input-VAT debit leg
(`tax_account_id` was NULL at legacy posting time). This repair **inserts the
missing `Dr VAT-Input` line** into each entry. It is additive only — no existing
line is edited or deleted.

| Entry | Invoice | Before | Missing leg |
|---|---|---|---|
| #7 `7c5301d1-48ad-4b02-9704-cb0ff79a299b` | PI-2026-0009 | Dr Inv 20,475.00 / Cr AP 20,491.38 (gap 16.38) | Dr VAT-Input **16.38** (invoice line rate 0.08%) |
| #8 `1117f5dd-594f-4403-8bba-a343d44d1551` | PI-2026-0010 | Dr Inv 2,178,750.00 / Cr AP 2,483,775.00 (gap 305,025.00) | Dr VAT-Input **305,025.00** (two 14% lines) |

**VAT-Input account:** `70f18bc7-1583-4298-a80b-4d56cafde805` (code 2300,
"ضريبة القيمة المضافة", leaf + active = `PostingProfile.vat_input_account`; no
`VAT_INPUT` system-role account exists).

## Backup

`scratchpad/prod-backup-pre-4A1-20260711-214050.sql` — full `pg_dump` (738 KB),
taken before any change.

## Dry run (ROLLBACK)

- All guards passed; both entries locked; gaps matched (16.38 / 305,025.00); no
  existing repair VAT lines.
- Simulated **unbalanced = 0** in-transaction, then `ROLLBACK`.
- Post-rollback: DB unchanged — unbalanced still **2**, negative stock **0**, **0**
  repair lines persisted.

## Real run (COMMIT)

- Unbalanced entries: **2 → 0**
- Entry #7 balanced: 20,491.38 Dr = 20,491.38 Cr
- Entry #8 balanced: 2,483,775.00 Dr = 2,483,775.00 Cr
- Negative stock: **0** (untouched)
- `/ar/accounting/journal` **200**, `/ar/accounting/statement` **200**, API `/journal` **200**

### Inserted journal_line IDs

| Entry | Line ID | Line |
|---|---|---|
| #7 (PI-2026-0009) | `0b2935c0-0f3e-4b4a-941f-3d95c5a642b2` | Dr VAT-Input(2300) 16.38 |
| #8 (PI-2026-0010) | `a700063e-3b99-46bf-a2d6-e9b391355e2c` | Dr VAT-Input(2300) 305,025.00 |

### Audit

2 rows in `audit_logs` — action `UPDATE`, entity_type `journal_entry`,
`after_snapshot->>'repair' = 'insert_vat_input_leg'`, with AR/EN summaries.

## Rollback

```sql
DELETE FROM journal_lines WHERE note LIKE 'Phase 4A-1 repair:%';
DELETE FROM audit_logs   WHERE after_snapshot->>'repair' = 'insert_vat_input_leg';
```
(Or restore `prod-backup-pre-4A1-20260711-214050.sql`.)

## Confirmations

- ✅ No existing journal lines edited or deleted.
- ✅ Only **2 additive** `journal_lines` inserted (note-marked).
- ✅ **2 audit rows** inserted.
- ✅ No unrelated data changed (unbalanced 2 → 0; no other entry affected).
- ✅ No opening balances started (Phase 4A-2 not started).
- ✅ No vouchers / returns started.
- ✅ No code, schema, or Prisma migration changes; nothing deployed.
