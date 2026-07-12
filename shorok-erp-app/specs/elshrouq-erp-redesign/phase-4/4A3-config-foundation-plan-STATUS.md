# Phase 4A-3 — Config Foundation Plan (Public-Safe)

**Date:** 2026-07-12 · **Type:** Planning/investigation only. No DB changes.

> Contains chart-of-accounts codes and system-role names only (safe). No
> balances, costs, or customer/supplier data. A fuller private note is retained
> under `private-notes/` (untracked).

## Goal
Establish the accounting config foundation before opening-balance work: assign
`system_role` to the control/result accounts and create an Opening-Balance-Equity
account. Planning only — nothing is created or assigned yet.

## 1. Accounts and proposed roles
| Proposed role | account code | leaf | active | current role |
|---|---|---|---|---|
| AR_CONTROL | 1240 | ✓ | ✓ | none |
| AP_CONTROL | 2100 | ✓ | ✓ | none |
| INVENTORY | 1250 | ✓ | ✓ | none |
| REVENUE | 4100 | ✓ | ✓ | none |
| COGS | 5100 | ✓ | ✓ | none |
| VAT_INPUT | 2300 | ✓ | ✓ | none |

All are leaf + active → **suitable for roles**. **No account currently has any
system_role** (clean slate).

**VAT note:** input and output VAT currently share one account (2300), and
`system_role` is unique per account — so VAT_INPUT and VAT_OUTPUT cannot both be
assigned to it. VAT roles are inert (nothing reads them yet), so this is a
future/cosmetic decision: assign VAT_INPUT now, and either leave VAT_OUTPUT
unassigned or split into two VAT accounts later.

## 2. Opening-Balance-Equity account (to create later)
Does not exist yet. Recommended: **code 3400**, name "رصيد افتتاحي" /
"Opening Balance Equity", category EQUITY, leaf, active, role OPENING_EQUITY
(alongside existing equity accounts 3000/3100/3200/3300).

## 3. Safety of role assignment
`system_role` is read in **exactly one place** in the codebase — the PostingEngine's
AR/AP-control party check. **No report or dashboard reads it** (they resolve accounts
by `category`/`accountType`). Therefore:
- Assigning **AR_CONTROL / AP_CONTROL** activates the "party required" rule for
  engine posts to those accounts.
- Assigning **INVENTORY / REVENUE / COGS / VAT_INPUT** has **no behavioral effect**
  (inert tags for future use).

**Caller audit:** all PostingEngine document flows (purchase → SUPPLIER, sales →
CUSTOMER, expense → SUPPLIER, reversal → mirrors) already pass a party on AR/AP →
**safe**. Legacy direct writers (order collections, supplier payments, payments,
fixed assets, and manual-journal *create*) bypass the engine → **unaffected**.

**One edge case:** reversing a *manual* journal that posted to AR/AP **without a
party** would be rejected after roles are assigned (the reverse path uses the
engine). Low-frequency and arguably correct; the manual-journal→engine migration
(Phase 4B) will add party support.

## 4. What is needed
- **No schema migration** (columns already exist).
- Two **data** changes later: create the OPENING_EQUITY account; set `system_role`
  on the six accounts — delivered as a guarded, dry-run-first, backup-gated script.

## 5. Proposed implementation split
- **4A-3a:** create OPENING_EQUITY (3400) + assign the six roles (dry-run → real, backup-gated).
- **4A-3b:** validation — run the posting/party integration suites; confirm reports and trial
  balance unchanged, GL untouched.
- **Deferred:** VAT_OUTPUT role (needs an account split) and any opening AR/AP entries.

## Confirmations (this step)
- ✅ No data changed · ✅ read-only investigation · ✅ no roles assigned · ✅ no OPENING_EQUITY
  created · ✅ no migrations · ✅ no deploy.
