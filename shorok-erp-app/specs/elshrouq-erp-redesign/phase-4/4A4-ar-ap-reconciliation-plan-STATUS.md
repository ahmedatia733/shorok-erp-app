# Phase 4A-4 — AR/AP Reconciliation Plan (Public-Safe)

**Date:** 2026-07-12 · **Type:** Planning/investigation only. No DB changes.

> Aggregate conclusions and risk labels only. No customer/supplier names, exact
> balances, invoice numbers, or raw DB output. A detailed note is retained
> privately under `private-notes/` (untracked).

## Key finding
The GL AR (1240) and AP (2100) control accounts are **already populated by real
POSTED document journals** (sales/purchase invoices posted through the engine
and via legacy writers). The historical balances were **entered as posted
documents**, not left as an empty slate awaiting opening entries. The
OPENING_EQUITY account (3400) is clean (zero) and the global trial balance is
balanced.

A legacy customer subledger carries **the same AR balance** already present in
the GL (a duplicate), and the legacy supplier "factory" ledger tracks a
different, fully-settled flow — so neither is a source to post opening AR/AP from.

## Classification
- **AR → `DO_NOT_POST_OPENING_DUE_TO_DOUBLE_COUNT_RISK`**
- **AP → `DO_NOT_POST_OPENING_DUE_TO_DOUBLE_COUNT_RISK`**

## Recommended authoritative source
- **AR:** the GL / posted document journals (the legacy customer subledger is a
  duplicate to be retired, not a posting source).
- **AP:** the GL / posted document journals (the legacy supplier "factory" ledger
  is a separate, settled operational ledger).

## Are opening entries safe now?
**No.** The balances already exist in the GL via posted invoices; posting opening
AR/AP would double- (or triple-) count. **Recommendation: skip opening AR/AP
entirely.** OPENING_EQUITY (3400) stays unused for AR/AP. Inventory is likewise
already reflected in the GL, so no inventory opening entry is needed either.

## Per-party opening entries required?
No — no opening entries at all. Instead, the relevant (optional) task is **party
enrichment**: most historical legacy AR/AP GL lines lack a CUSTOMER/SUPPLIER
party dimension. GL-based **per-party** AR/AP reporting cannot be trusted until
those lines are enriched (a small scope — a handful of parties).

## Double-count risks identified
1. The same AR balance exists in both the GL (a posted invoice) and the legacy
   customer subledger.
2. Legacy receipt/manual journal entries are already in the GL.
3. The legacy supplier ledger and GL AP track different flows — GL AP must not be
   derived from the supplier ledger.
4. Reversed test-entry pairs are present (net zero; harmless noise).

## Party-dimension gaps
Only the recent engine-posted invoices carry a party on AR/AP; the older legacy
lines do not. Enrichment is a small, bounded task if GL-based per-party reports
are wanted before legacy retirement.

## Proposed next split
- **4A-4a:** read-only reconciliation report + business sign-off that the GL AR/AP
  match the intended balances (no posting).
- **4A-4b (optional, pre-4C):** enrich legacy no-party AR/AP GL lines with party.
- **Deferred to Phase 4C (vouchers-dependent):** retire the legacy subledgers and
  migrate customer/supplier statements + dashboard to read the GL.

## Confirmations
- ✅ No data changed · ✅ read-only · ✅ no opening entries · ✅ no posting to 3400
  · ✅ no migrations · ✅ no deploy.
