# Phase 4A — Final Closure Summary

**Date:** 2026-07-12 · **Status:** ✅ Closed at a clean, production-safe stopping point
**origin/main at closure:** `6ec912b`

> Public-safe summary — aggregate status, commit references, decisions, and
> remaining risks only. No balances, customer/supplier names, private variant IDs,
> or backup paths. Detailed per-step reports are retained privately (untracked).

---

## 1. Objective
Bring the accounting layer to a correct, GL-authoritative baseline after Phase 3:
fix historical defects, establish item-level inventory cost, put the accounting
configuration foundation in place, and decide the AR/AP opening-balance strategy —
all incrementally, backup-gated, and without disturbing the live ledger.

## 2. What was completed
| Step | Outcome | Commit(s) |
|---|---|---|
| **4A-1** Historical VAT repair | The 2 legacy unbalanced purchase entries repaired (missing input-VAT leg added, additive-only) → unbalanced 2 → 0 | `3c454dc` (docs) |
| **4A-2 / 4A-2a** Inventory avg_cost audit | Candidate opening cost derived for all stocked, uncosted variants (0 blocked) | `d9f4bc0`, `8d2c04e` |
| **4A-2b/2c/2d** avg_cost load | 19 bulk-accepted variants costed via guarded, dry-run-first, backup-gated script | (data-only run) |
| **4A-2f** TEST residual cleanup | 1 residual inactive TEST stock zeroed via InventoryEngine ADJUSTMENT (no GL impact, history preserved) | `68c1874` |
| **4A-2h** Accepted manual-review cost | 1 additional variant costed (ACCEPT_PURCHASE_LINE) | `b144af2` |
| **4A-2i** Held manual overrides | 2 variants formally held for business-confirmed costs | `27811ba` |
| **4A-3 / 4A-3a** Config foundation | 6 system roles assigned (AR/AP control, inventory, revenue, COGS, VAT-input) + OPENING_EQUITY account 3400 created | `aa03900`, `39a2673` |
| **4A-3b** Validation | 64/64 focused integration tests pass; party guard + document flows validated; reports/pages smoke 200; production integrity intact | `814fe4e` |
| **4A-4** AR/AP reconciliation plan | AR & AP classified `DO_NOT_POST_OPENING_DUE_TO_DOUBLE_COUNT_RISK` | `0ec82a0` |
| **4A-4a** AR/AP sign-off | GL confirmed authoritative; opening AR/AP/inventory entries skipped | `6ec912b` |

## 3. Current production-safe state
- **Unbalanced journal entries = 0.**
- **OPENING journal entries = 0.**
- **OPENING_EQUITY account 3400 exists** (EQUITY, leaf, active) and **remains unused for AR/AP**.
- **AR/AP opening entries skipped** — historical balances already live in the GL via posted invoices.
- **GL is the authoritative source** for AR, AP, and inventory.
- **7 accounts carry a system_role** (6 mapped + OPENING_EQUITY).
- **VAT_OUTPUT role deferred** (input/output currently share one account; needs a split).
- **2 held inventory variants** remain uncosted, pending business-confirmed costs (no accounting impact — they sit outside the GL).
- Inventory is item-level costed for all other stocked variants; COGS now posts on their sales.

## 4. What was deliberately NOT done
- No opening AR / AP / inventory journal entries (would double-count balances already in the GL).
- No posting to OPENING_EQUITY 3400.
- No party enrichment of historical legacy GL lines.
- No costing of the 2 held variants (await business input).
- No VAT_OUTPUT role assignment (needs a VAT-account split).
- No legacy subledger retirement, no report migration, no vouchers.

## 5. Remaining risks
1. A small AR difference between the GL and the legacy customer subledger — explainable
   (payment/collection recording), to be reconciled precisely in Phase 4C.
2. Several legacy AR/AP control lines lack a party dimension → GL-based **per-party** AR/AP
   reporting is not yet trustworthy (enrichment deferred to 4C).
3. Legacy subledgers (customer/supplier/collections) are still actively written — their
   retirement depends on vouchers replacing the write paths (4C).
4. Reversed test-entry pairs remain in the ledger as net-zero noise.
5. Pre-existing unrelated `dashboard` seed test failure (not introduced by Phase 4A).

## 6. What moves to Phase 4B / 4C
- **Phase 4B:** migrate the remaining legacy direct writers to the PostingEngine
  (notably manual `POST /journal` create, adding party support); vouchers foundation.
- **Phase 4C:** legacy ledger retirement — reconcile the residual AR difference, enrich
  party on legacy lines, retire `customer_transactions` / `order_collections` /
  `factory_ledger`, and migrate customer/supplier statements + dashboard to read the GL.
  Depends on vouchers for the collection/payment write paths.

## 7. Recommended next phase
1. **Phase 4B — vouchers / legacy-writer migration:** receipt & payment vouchers (through
   the engine, with treasury accounts and party), plus manual-journal → engine migration.
   This unblocks legacy retirement.
2. **Phase 4C — legacy retirement + report migration:** once vouchers exist, repoint reports
   to the GL, dual-run to reconcile, then decommission the legacy subledgers.
- Separate, small tracks that can proceed anytime: business-confirmed costs for the 2 held
  variants; the VAT-account split enabling the VAT_OUTPUT role.

## 8. Confirmations (this closure step)
- ✅ No code / schema changes.
- ✅ No data changes (documentation only).
- ✅ No migrations.
- ✅ No deploy.
