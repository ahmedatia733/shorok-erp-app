# Phase 4A-2a — Inventory Opening-Cost Audit & Caller Audit (Public-Safe Summary)

**Date:** 2026-07-11 · **Type:** Read-only investigation (no data changed)
**Query:** [`inventory-avg-cost-candidates.sql`](./inventory-avg-cost-candidates.sql)

> **Redaction notice.** This is a public-safe summary. The detailed SKU-level
> candidate table (per-variant costs, branch-level stock quantities,
> supplier/factory-derived prices) and exact GL balances are **retained
> privately and NOT committed** (`private-notes/…-FULL.md`, untracked). Only
> high-level counts, distributions, risk categories, and code-behavior findings
> appear here.
>
> No `avg_cost` was set, no journal/opening entries were created, no roles were
> assigned, no data was modified.

---

## Part 1 — Inventory avg_cost candidate report (summary only)

### Scope & counts
| Metric | Value |
|---|---|
| Total stocked variants (boards > 0) | **34** |
| Stocked, `avg_cost = 0` (need review) | **32** |
| Stocked, `avg_cost > 0` (already costed) | 2 |

Most of the physical stock volume already sits in the **2 pre-costed** variants;
the 32 uncosted variants are a comparatively small share of total quantity.

### Candidate cost resolution
Each uncosted variant gets a candidate opening cost per board via a trust
hierarchy (most trustworthy first): **(1) purchase-invoice-line weighted average
→ (2) factory-ledger price → (3) default purchase price**.

| Confidence | Source | Count |
|---|---|---|
| HIGH | purchase invoice lines | 12 |
| MEDIUM | factory ledger | 19 |
| LOW | default purchase price | 1 |
| BLOCKED | unresolved | **0** |

**Every uncosted variant resolves** (0 BLOCKED).

### Reconciliation flag
Summing the candidate item-level inventory value and comparing it to the GL
inventory control account shows a **non-trivial reconciliation gap** (item-level
value exceeds the GL balance). **Exact amounts are withheld here** (see private
report). This gap must be explained during private review **before** any
inventory valuation / opening-equity entry. The avg_cost load itself does not
touch the GL and does not depend on resolving this gap.

### Risk categories (no exact values)
- **Source-disagreement variants** — a handful where the purchase-line price and
  the factory/default price diverge materially (both over- and under-statement
  cases). These need per-item human review/override before loading.
- **Residual test data** — at least one clearly-named TEST variant still carries
  stock with `avg_cost = 0`; it must be **excluded from the load and cleaned up**
  (never cost test data).
- **Structural gap** — the item-level-vs-GL reconciliation gap noted above.

The specific SKUs, quantities, costs, and amounts for each category are in the
private full report.

---

## Part 2 — Caller audit (code behavior — safe to publish)

**Key fact:** the "party required on AR/AP control account" rule is enforced
**only in `PostingEngine` code** ([posting.engine.ts](../../../apps/api/src/modules/posting/posting.engine.ts)).
There is **no DB constraint or trigger** on `journal_lines` for party. Therefore
assigning `AR_CONTROL`/`AP_CONTROL` system roles affects **only PostingEngine.post
callers**; legacy direct writers bypass the engine and are unaffected.

| Caller | Path | Vehicle | Sets party? | Role-assignment impact |
|---|---|---|---|---|
| Purchase confirm (3A) | `purchase-invoices.controller` | PostingEngine | **Yes** (SUPPLIER) | **SAFE** |
| Sales confirm (3B) | `sales-invoices.controller` | PostingEngine | **Yes** (CUSTOMER) | **SAFE** |
| Expense post (3C) | `expenses.controller` | PostingEngine | **Yes** (SUPPLIER on credit) | **SAFE** |
| Reversal (3D) | `posting/reversal.service` | PostingEngine | **Yes** (mirrors party) | **SAFE** |
| Manual journal | `journal.controller` POST /journal | direct `journalEntry.create` | No | **SAFE now** (bypasses engine); **must add party before its 4B engine migration** |
| Order collections | `orders/collections.controller` | direct | No | SAFE now (bypasses engine); no-party data-quality gap → Phase 4C |
| Supplier payments | `factory-ledger/payments.controller` | direct | No | SAFE now (bypasses engine); no-party gap → Phase 4C |
| Payments | `payments/payments.controller` | direct | No | SAFE now (bypasses engine); no-party gap → Phase 4C |
| Fixed assets | `fixed-assets/fixed-assets.controller` | direct | No | SAFE (no AR/AP party need) |
| Customer transactions | `customers.controller` | legacy subledger (no GL write) | n/a | SAFE |

**Verdict:** assigning AR/AP control roles is **safe today** — every engine caller
that hits AR/AP already supplies a party; the 5 legacy direct writers bypass the
engine's check entirely. Follow-on requirement: when `POST /journal` is migrated
to the engine (Phase 4B), it must first gain party support.

---

## Part 3 — Recommended safe next step
1. **System-role assignment can be done safely** (per the audit) but has no
   functional need in 4A-2a — bundle it into the config-foundation step (4A-2b)
   with the opening-equity account, after private review.
2. **No caller needs fixing** to proceed; `POST /journal` party support is a 4B
   concern only.
3. **Do NOT run the avg_cost load yet.** It is technically safe to run as a
   guarded script (0 BLOCKED), but only **after** private review of: the
   source-disagreement variants, exclusion/cleanup of the residual TEST variant,
   a DB backup, and a transaction with a rollback marker.
4. **Opening equity + inventory valuation entry must wait** until the
   reconciliation gap is explained in private review; the avg_cost load itself
   needs neither.

## Confirmations
- ✅ No data changed · ✅ No `avg_cost` changed · ✅ No opening/journal entries
  created · ✅ No system roles assigned · ✅ No OPENING_EQUITY created ·
  ✅ Read-only SELECTs only · ✅ Detailed figures retained privately, not committed.
