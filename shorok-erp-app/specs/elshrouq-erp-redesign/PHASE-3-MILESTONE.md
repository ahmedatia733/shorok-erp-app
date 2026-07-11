# Phase 3 Milestone — Accounting Posting & Reversal-Hardening

**Status:** ✅ Complete and deployed to the test environment
**Date:** 2026-07-11
**Environment:** Railway test environment (not live with real clients yet)

> Documentation only — records the final deployed accounting state after
> Phases 3A → 3D. No behavior described here is pending; all of it is live.

---

## 1. Current deployed state

| Item | Value |
|---|---|
| `origin/main` | **`08ec388`** |
| Latest API deployment | **`3a141906`** |
| Web service | `perpetual-warmth` — Online |
| Database | PostgreSQL 18.4 (Railway) — Online |
| Auto-deploy | GitHub `main` → Railway (Dockerfile.api runs `prisma migrate deploy` on every deploy) |

**Migrations applied this phase (additive only, no drops):**
- `20260710000000_purchase_costing_fields` (3A)
- `20260711000000_sales_costing_fields` (3B)
- `20260712000000_expense_posting_fields` (3C)
- `20260712000100_expense_reversal_fields` (3D)

---

## 2. Completed phases

| Phase | Scope | Commit |
|---|---|---|
| **3A** | Purchase-invoice posting via PostingEngine (WAC costing, AP party, input VAT, snapshots) | `2046c5b` |
| **3B** | Sales-invoice posting via PostingEngine (revenue + COGS from `avg_cost`, AR party, output VAT) | `a519b5a` |
| **Hotfix** | Sales-cancel FK-ordering bug (P2003) fixed | `5cbb4c5` |
| **3C** | Expenses posting via PostingEngine (paid / taxable / on-credit; transitional record-only fallback) | `67c31ce` |
| **3D (1/2)** | Core reversal hardening — `POST /journal/:id/reverse`, `DELETE /journal/:id` blocked, ReversalService `tx` passthrough | `5891ee7` |
| **3D (2/2)** | Document reversal integration — purchase/sales/expense cancels reverse instead of delete | `08ec388` |

---

## 3. What is now guaranteed

- **Purchases** post through the single **PostingEngine** path (`Dr Inventory / Dr VAT-Input / Cr AP [SUPPLIER party]`, balanced, WAC `avg_cost` built forward).
- **Sales** post through the PostingEngine — a revenue entry (`Dr AR [CUSTOMER party] / Cr Revenue / Cr VAT-Output`) and a COGS entry (`Dr COGS / Cr Inventory` from `avg_cost`, skipped when `avg_cost = 0`).
- **Expenses** post through the PostingEngine when accounts resolve (category → account, treasury or on-credit AP, optional input VAT); otherwise recorded record-only.
- **Posted journal entries are immutable** (Constitution VII) — never edited or hard-deleted.
- **Cancels create reversals, not deletions** — the original entry is marked `REVERSED`, a mirror entry (debit↔credit, party/branch preserved) nets it to zero, linked via `reversal_of_id`.
- **`DELETE /journal/:id` is blocked** → `409 use_reverse_instead`.
- **SALE and RECEIPT inventory movements are retained** — history is never deleted.
- **Stock compensation uses a compensating `ADJUSTMENT`** movement through the InventoryEngine (non-negative guard: a purchase cancel is blocked with `insufficient_stock` if the received stock was already sold).
- **A posted expense reversal retains the row** — `status = REVERSED`, original `journal_entry_id` stays linked, `reversal_journal_entry_id` stores the mirror; only `RECORDED` (record-only + negative corrections) expenses may be hard-deleted.
- **All posting is period-guarded** — entries (and reversals, dated today) require an `OPEN` financial period, else `period_not_open` / `period_closed`, atomically.
- **All posting is idempotent** — deterministic keys (`PURCHASE_INVOICE:<id>`, `SALES_INVOICE:<id>`, `SALES_INVOICE:<id>:COGS`, `EXPENSE:<id>`, `reversal:<id>`) prevent double-posting and make repeat cancel/reverse a no-op.

---

## 4. Known remaining warnings (carried forward)

- **2 historical unbalanced journal entries remain** (#7 2026-07-01, #8 2026-07-02) — owned by **Phase 4** reconciliation; now protected by the removed delete path.
- **Dashboard seed issue is pre-existing** — one integration test (`dashboard › OWNER all-branches view aggregates everything`) fails because the seeded "Mega Bond" supplier appears in `supplierBalances`; unrelated to Phase 3.
- **Auth bootstrap 401 console noise is cosmetic** — the api-client probes `GET /auth/me` + `POST /auth/refresh` on each page mount; no functional impact.
- **Legacy record-only expense fallback still exists** — expenses with no resolvable accounts are recorded without a GL entry (transitional; hard-mandatory posting awaits UI/config cleanup).
- **Legacy `CustomerTransaction` still exists** and is still deleted on sales cancel — the legacy parallel AR ledger is removed in **Phase 4**.
- **Manual journal create (`POST /journal`) is still a legacy direct writer** — it does not yet post through the PostingEngine (its reverse path is hardened, its create path is not migrated).
- **Vouchers not implemented** (receipt / payment vouchers).
- **Returns not implemented** (sales / purchase returns).
- **Reports not redesigned** — they sum journal lines by date with no status filter, so reversal pairs net to zero automatically; no report changes were required.

---

## 5. Test status

| Check | Result |
|---|---|
| Deployed E2E smoke | ✅ **READY** (9 pages + login, all 200, no crashes) |
| Journal displays REVERSED entries | ✅ safe (4 REVERSED entries present, page renders) |
| Expenses display RECORDED/POSTED/REVERSED | ✅ safe |
| Cancelled purchase/sales display | ✅ no crash |
| Negative stock | ✅ **0** |
| Unbalanced entries | ✅ **exactly 2 historical only** |
| New unbalanced entries | ✅ none (all reversals net to zero) |
| 500 API errors | ✅ none |
| Prisma P2003 (FK) errors | ✅ none |
| Missing-column errors | ✅ none |
| Full integration suite | 198 passed / 1 failed (the pre-existing dashboard seed test) |

---

## 6. Recommended next phases (planning only — not started)

1. **Phase 4 planning** — historical cleanup (the 2 unbalanced entries), opening balances (opening `avg_cost`, opening equity), and retirement of legacy ledgers (`CustomerTransaction`, `FactoryLedgerEntry`, string `paid_from_account`).
2. **Voucher planning** — receipt / payment vouchers with treasury accounts and invoice allocation.
3. **Reports planning** — trial balance / VAT report / customer & supplier statements / P&L polishing on top of the now-consistent GL.
4. **Manual journal create migration** — route `POST /journal` through the PostingEngine (period guard, idempotency, status) to close the last legacy direct-writer.

---

*Constitution v2.0.0 — Principles VI (single posting path), VII (posted-record
immutability), VIII (configuration over hardcoding) — are now enforced across
purchases, sales, and expenses. Phase 3 is closed.*
