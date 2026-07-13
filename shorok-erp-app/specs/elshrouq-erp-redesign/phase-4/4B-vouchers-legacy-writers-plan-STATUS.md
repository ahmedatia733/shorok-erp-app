# Phase 4B — Vouchers & Legacy-Writer Migration Plan (Public-Safe)

**Date:** 2026-07-12 · **Type:** Planning/investigation only. No DB/code changes.

> Architecture, planned endpoints, risks, and the phase split only. No customer/
> supplier names, balances, invoice numbers, or raw DB output. A detailed note is
> retained privately under `private-notes/` (untracked).

## Objective
Introduce receipt/payment vouchers that post through the single PostingEngine
path, and migrate the remaining legacy direct-journal writers onto the engine —
preparing (but not executing) the legacy-ledger retirement that Phase 4C performs.

## Legacy write paths (all bypass the PostingEngine today)
| Path | Current behavior | Replace with |
|---|---|---|
| Order collections (`POST /orders/:id/collections`) | `Dr cash / Cr AR`, **no party** | Receipt voucher |
| Supplier payments (`POST /payments/supplier-payments`) | `Dr AP / Cr bank`, **no party** | Payment voucher |
| Factory-ledger payments | ledger row + optional `Dr/Cr` | Payment voucher (ledger retired in 4C) |
| Generic treasury payments | treasury record | treasury/voucher model |
| Customer transactions (`POST /customers/transactions`) | legacy AR subledger row, **no GL entry** | Retire (AR = GL) in 4C |
| Manual journal (`POST /journal`) | direct `journalEntry.create`, **no party** | Migrate to PostingEngine |
| Fixed assets | direct `journalEntry.create` (not AR/AP) | Optional later migration |

## PostingEngine flows already safe
Purchase invoices, sales invoices, expenses, and reversals already post through
the engine with a party on AR/AP — the model to copy for vouchers.

## Prerequisites discovered
- **Voucher models do not exist yet** (`ReceiptVoucher`/`PaymentVoucher`/`VoucherAllocation`
  were specced but never migrated) → 4B adds them (additive schema).
- **GL treasury accounts are not set up** (`is_cash_or_bank`/`treasury_type` columns exist but
  no account is flagged; treasury lives only in a legacy table) → 4B configures them.
- AR/AP control roles are **live**, so any engine post to AR/AP now **requires a party** — which
  forces vouchers and manual journals to carry one.

## Voucher types
- **Receipt voucher (customer receipt) — required:** `Dr Treasury / Cr AR [CUSTOMER party]`;
  endpoints `POST /receipt-vouchers` (+ `/:id/reverse`); idempotency `RECEIPT_VOUCHER:<id>`;
  reversal via ReversalService; optional allocation to sales invoices.
- **Payment voucher (supplier payment) — required:** `Dr AP [SUPPLIER party] / Cr Treasury`;
  endpoints `POST /payment-vouchers` (+ reverse); key `PAYMENT_VOUCHER:<id>`; optional allocation
  to purchase invoices.
- **Cash/bank transfer voucher — optional:** `Dr Treasury B / Cr Treasury A` (no party).
- **Manual journal via PostingEngine — required** (see below).
- **Opening/adjustment voucher — not needed** (AR/AP sign-off = no opening entries).

## Manual journal migration
Route `POST /journal` create through the PostingEngine (period guard, sequence
numbering, idempotency, status, audit-in-tx, and the **party-required guard on
AR/AP control accounts**). Add optional party fields to the manual-journal line
input so AR/AP lines can carry a party; a partyless AR/AP manual entry will be
**rejected** by the engine — the "prevent partyless AR/AP" goal. `DELETE` stays
blocked (`use_reverse_instead`); corrections via the reverse endpoint.

## Risks
1. **Double posting** — a legacy collection/payment and a voucher for the same event would double
   the GL; sequence the cutover, no dual-write.
2. **Duplicate customer/supplier balances** — legacy subledgers already duplicate/diverge from the
   GL; vouchers post to the GL (authoritative), legacy writes freeze at cutover (4C).
3. **Partyless AR/AP** — manual-journal migration enforces party going forward; historical legacy
   lines are enriched in 4C.
4. **UI dependencies** — the UI calls the legacy endpoints; new voucher endpoints need UI wiring;
   keep legacy read paths during transition.
5. **Backward compatibility** — legacy statements/reports must keep working until 4C dual-runs and
   reconciles GL vs legacy, then decommissions.

## Proposed Phase 4B split
- **4B-0:** GL treasury account config (guarded, dry-run-first).
- **4B-1:** voucher schema (additive migration + numbering).
- **4B-2 / 4B-3:** receipt / payment voucher endpoints (create + reverse) via PostingEngine + tests.
- **4B-4:** manual journal → PostingEngine migration (+ party support) + tests.
- **4B-5 (optional):** transfer voucher.
- **4B-6:** validation (integration suites + deployed smoke).
- Each step: commit-per-increment, backup-gated for data steps, dry-run first, deployed verify.

## Deferred to Phase 4C
Freeze legacy writes; migrate customer/supplier statements + dashboard to the GL;
enrich party on historical legacy lines; reconcile the residual AR difference;
decommission the legacy subledgers.

## Confirmations
- ✅ No data changed · ✅ read-only · ✅ no code/schema/migration · ✅ no deploy.
