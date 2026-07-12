# Phase 4A-2d — avg_cost Real Run Status (Public-Safe)

**Date:** 2026-07-12 · **Type:** Data-only opening-cost load. No GL/journal impact.

> **Redaction notice.** Exact variant IDs, SKU codes, per-variant costs, stock
> quantities, branch names, and GL balances are retained **privately and NOT
> committed** (`private-notes/4A2d-avg-cost-real-run-FULL.md`, untracked). Only
> aggregate counts and safety confirmations appear here.

## Outcome
- ✅ **Real run completed** — the guarded avg_cost load ran in real mode and
  committed after all in-transaction guards passed (affected count matched the
  planned set; GL before/after identical).
- **19 accepted variants updated** with a weighted-average opening cost (derived
  from the purchase-line → factory-ledger → default-price hierarchy).
- **4 stocked variants remain `avg_cost = 0`:**
  - **3** require **manual override** (held out pending business-confirmed costs).
  - **1** is **test/inactive** (to be cleaned up).

## Integrity confirmations
| Check | Result |
|---|---|
| Stocked `avg_cost = 0` (before → after) | 23 → **4** |
| Variants updated | **19** |
| `avg_cost > 0` overwritten | **0** (only rows that were 0 were touched) |
| OPENING entries created | **0** |
| Journal entries | unchanged |
| Journal lines (count + balance) | **unchanged** (GL untouched) |
| Unbalanced entries | **0** |
| System roles assigned | none |
| OPENING_EQUITY created | none |
| Code / schema / migration changes | **none** |
| Deploy | none |

- A **full DB backup was taken before the run** (path withheld — private).
- Sensitive per-variant output was captured privately and not committed.

## Net effect
The 19 costed variants will now post COGS on future sales (previously skipped at
`avg_cost = 0`). The 4 remaining uncosted variants have **no accounting impact**
(they sit outside the GL). No opening/valuation entry was posted — the
inventory-value reconciliation remains a separate, later step.

## Still pending (separate approvals)
- Business-confirmed costs for the 3 manual-override variants.
- Cleanup of the 1 residual test variant.
- Config foundation (system roles, OPENING_EQUITY) and AR/AP reconciliation.
