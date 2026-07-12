# Phase 4A-3a — Config Foundation Real Run Status (Public-Safe)

**Date:** 2026-07-12 · **Type:** Data-only config (account + system-role tags). No GL/journal impact.

> Contains chart-of-accounts codes and role names only (safe). No balances,
> costs, backup paths, raw SQL output, or customer/supplier data. A detailed
> report is retained privately under `private-notes/` (untracked).

## Outcome
- ✅ **6 accounting roles assigned** to their control/result accounts:
  | role | account code |
  |---|---|
  | AR_CONTROL | 1240 |
  | AP_CONTROL | 2100 |
  | INVENTORY | 1250 |
  | REVENUE | 4100 |
  | COGS | 5100 |
  | VAT_INPUT | 2300 |
- ✅ **OPENING_EQUITY account `3400` created** (category EQUITY, leaf, active,
  role OPENING_EQUITY) — the balancing account for future opening-balance entries.
- **Total accounts now carrying a system_role: 7** (the 6 above + OPENING_EQUITY).
- **VAT_OUTPUT intentionally remains unassigned** — input and output VAT share
  account 2300 and `system_role` is unique per account; VAT_OUTPUT awaits a later
  VAT-account split.

## Integrity confirmations
| Check | Result |
|---|---|
| Journal entries created | **none** |
| OPENING journal entries | **0** (unchanged) |
| GL / journal (count + balance) | **unchanged** |
| Unbalanced entries | **0** |
| avg_cost aggregate | **unchanged** |
| Code / schema / migration changes | **none** (data-only) |
| Deploy | none |

## Behavioral effect
`system_role` is read in exactly one place — the PostingEngine's AR/AP-control
party check. So `AR_CONTROL`/`AP_CONTROL` now **enforce a party on engine posts**
to accounts 1240/2100 (all current document flows already pass one). The other
role tags are inert until used. No report or dashboard reads `system_role`, so
reporting is unaffected.

## Next (separate approvals)
- Business-confirmed costs for the 2 held manual-override variants.
- AR/AP reconciliation and opening-balance entries (which will use OPENING_EQUITY 3400).
