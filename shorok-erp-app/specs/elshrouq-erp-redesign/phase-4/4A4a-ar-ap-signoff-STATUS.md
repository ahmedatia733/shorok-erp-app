# Phase 4A-4a — AR/AP Reconciliation Sign-Off Status (Public-Safe)

**Date:** 2026-07-12 · **Type:** Read-only sign-off. No DB changes.

> Risk labels, aggregate counts, and the decision only. No customer/supplier
> names, exact balances, invoice numbers, or raw DB output. A detailed note is
> retained privately under `private-notes/` (untracked).

## Purpose
Confirm, from a read-only reconciliation, that **no opening AR/AP entries should
be posted** — the historical balances already live in the GL via posted invoices.

## AR — sign-off
- The GL AR (1240) balance is carried by **posted sales invoices** (the bulk from
  engine-posted invoices with a party dimension, plus a few legacy lines).
- The legacy customer subledger carries **the same AR balance** already in the GL
  (a duplicate). The small difference between the two is **explainable** (customer
  payments/collections recorded differently between the ledgers) and immaterial to
  the opening decision.
- **Recommendation: SKIP opening AR.** GL is authoritative.

## AP — sign-off
- The GL AP (2100) balance is carried by **posted purchase invoices** (engine +
  legacy).
- The legacy supplier "factory" ledger tracks a **different, fully-settled flow**
  (supplier orders, zero owed) — it is not a second view of the payable and must
  not be used as an AP opening source.
- **Recommendation: SKIP opening AP.** GL is authoritative.

## Opening-entry decision
| Entry | Decision |
|---|---|
| AR opening | ❌ not posted (already in GL) |
| AP opening | ❌ not posted (already in GL) |
| Inventory opening | ❌ not posted (already in GL) |
| OPENING_EQUITY (3400) for AR/AP | ✅ remains **unused** (net zero, 0 OPENING entries) |

## Party-enrichment classification
A number of **legacy AR/AP control lines lack a CUSTOMER/SUPPLIER party** (only the
recent engine-posted invoices carry one). Current reports read the legacy
subledgers, not the GL by party, so enrichment is **not needed now**.
- **Classification: `DEFER_TO_PHASE_4C`** (optional while legacy reports remain;
  required only when GL-based per-party AR/AP reports replace them).

## Remaining risks
1. A small AR (GL-vs-legacy) difference to reconcile precisely during Phase 4C.
2. Legacy no-party control lines block GL-based per-party reporting until enriched.
3. Legacy subledgers are still actively written → retirement needs vouchers (4C).
4. Reversed test-entry pairs are net-zero noise.

## Proposed next split
- **4A-4a (this):** sign-off — skip opening AR/AP/inventory. ✅
- **Deferred → Phase 4C:** reconcile the residual difference, enrich party on legacy
  lines, retire legacy subledgers, migrate customer/supplier statements + dashboard
  to the GL (vouchers-dependent).
- **Separate track:** business-confirmed costs for the 2 held inventory variants.

## Confirmations
- ✅ No data changed · ✅ read-only · ✅ no opening entries · ✅ no posting to 3400
  · ✅ no migrations · ✅ no deploy.
