# Phase 4A-2h — avg_cost Real Run (single accepted variant) Status (Public-Safe)

**Date:** 2026-07-12 · **Type:** Data-only opening-cost load. No GL/journal impact.

> **Redaction notice.** The exact SKU code, variant ID, cost, branch, stock
> quantities, backup path, and GL balances are retained **privately and NOT
> committed** (a detailed report under `private-notes/`, untracked). Only
> aggregate counts and safety confirmations appear here.

## Outcome
- ✅ **One accepted manual-review variant was costed** — the business decision was
  `ACCEPT_PURCHASE_LINE` (use its actual invoiced purchase cost). The guarded load
  ran in real mode and committed after all in-transaction guards passed.
- **Remaining stocked `avg_cost = 0` variants: 2.**
- The remaining **2 require business-confirmed numeric costs** before they can be
  loaded (still held as `MANUAL_NUMERIC_OVERRIDE_REQUIRED`).

## Integrity confirmations
| Check | Result |
|---|---|
| Variants updated | **1** |
| Remaining stocked `avg_cost = 0` (before → after) | 3 → **2** |
| The 2 held variants | **untouched** (still `avg_cost = 0`) |
| GL / journal impact | **none** (byte-identical before/after) |
| OPENING entries created | **0** |
| Journal entries | unchanged |
| Unbalanced entries | **0** |
| Code / schema / migration changes | **none** |
| Deploy | none |

- A **full DB backup was taken before the run** (path withheld — private).

## Net effect
The costed variant will now post COGS on future sales (previously skipped at
`avg_cost = 0`). The 2 remaining uncosted variants have **no accounting impact**
(they sit outside the GL) and await business-confirmed costs.

## Still pending (separate approvals)
- Business-confirmed numeric costs for the **2 remaining** manual-override variants.
- Config foundation (system roles, OPENING_EQUITY) and AR/AP reconciliation.
