# Phase 4A-2b — avg_cost Load Prep Status (Public-Safe)

**Date:** 2026-07-11 · **Type:** Prep only — no data changed, nothing run.

> **Redaction notice.** The per-variant review table (variant IDs, costs, stock
> quantities) and the guarded load script are retained **privately and NOT
> committed** (`private-notes/4A2b-avg-cost-load-review.md` and
> `private-notes/4A2b-avg-cost-load.sql`, untracked). Only aggregate counts and
> the safety design appear here.

## Load scope (aggregate)
| Metric | Count |
|---|---|
| Distinct stocked variants with `avg_cost = 0` | **23** |
| **Included in load** (active, non-test, candidate resolved) | **22** |
| **Excluded** (test/inactive) | **1** |
| Excluded (unresolved candidate) | **0** |

*(32 stocked balance rows map to 23 variants — some variants are stocked in two
branches; `avg_cost` is per-variant, so the load updates 22 variant rows.)*

## Safety design of the guarded script
- Runs in a **single transaction**; **dry-run by default** (rolls back), real run
  only with an explicit flag.
- Updates **only** `product_variants` where `avg_cost = 0` — never overwrites an
  existing positive cost.
- **Excludes** inactive variants/SKUs, TEST/DEMO SKUs, and unresolved candidates.
- **Creates no journal/opening entry**; snapshots `journal_lines` before/after and
  **aborts if the GL changed**.
- Verifies the **affected count matches the expected set** before commit.
- Prints the full before/after plan; includes rollback instructions.

## Status
- ✅ Candidate rows identified; test/residual variant excluded.
- ✅ Guarded script + private review table prepared.
- ⏸ **Not run** — no dry-run executed, no real update executed.
- ⏳ **Pending private review** of the source-disagreement variants before any run.

## Next step (on approval)
Run the script in **dry-run mode** (auto-rollback) to confirm the plan and the
GL-unchanged guard, then — only after review of the flagged variants — the real
run under backup.
