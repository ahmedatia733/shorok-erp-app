# Phase 4A-2i — Held Manual-Override Variants Status (Public-Safe)

**Date:** 2026-07-12 · **Type:** Documentation only. No DB changes.

> **Redaction notice.** The specific SKU codes, variant IDs, candidate costs,
> branch, and stock quantities of the held variants are retained **privately and
> NOT committed** (a detailed note under `private-notes/`, untracked). Only the
> safe summary appears here.

## Status
After the earlier opening-cost steps (bulk accepted variants costed, the residual
test stock cleaned, and one accepted manual-review variant costed), exactly
**2 stocked variants remain `avg_cost = 0`**.

- Both are **intentionally held**.
- Both **require business-confirmed numeric costs** before they can be loaded
  (their automatically-derived candidate cost diverges materially from the
  alternative cost sources, so a human decision is required per item).

## What happens next
When the business confirms a per-board cost for each held variant, each is loaded
with the guarded, dry-run-first, backup-gated procedure used previously — a
data-only `avg_cost` update with **no GL/journal impact**.

## Integrity confirmations (this step)
| Check | Result |
|---|---|
| DB changes in this step | **none** (documentation only) |
| avg_cost changes | none (both held variants unchanged) |
| GL / journal impact | **none** |
| OPENING entries | **0** |
| Code / schema / migration changes | **none** |
| Deploy | none |

## Remaining (separate approvals)
- Business-confirmed numeric costs for the **2 held variants**.
- Config foundation (system roles, OPENING_EQUITY) and AR/AP reconciliation.
