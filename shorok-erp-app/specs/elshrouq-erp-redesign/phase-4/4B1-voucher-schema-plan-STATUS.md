# Phase 4B-1 — Voucher Schema Plan (Public-Safe)

**Date:** 2026-07-13 · **Type:** Design/investigation only. No schema/code/DB changes.

> Architecture, proposed models, statuses, lifecycle, and the migration/test split
> only. No customer/supplier names, balances, invoice numbers, DB URLs, or private
> IDs. A detailed design note is retained privately under `private-notes/`.

## Goal
Design the additive DB foundation for receipt/payment vouchers + allocations —
without implementing it yet. The Phase-3D **Expense** model (status + reversal)
is the template.

## Key reuse findings
- `JournalSourceType` **already contains** `RECEIPT_VOUCHER` and `PAYMENT_VOUCHER` →
  **no source-type enum migration needed.**
- Invoices/journal number via `BigInt @unique @default(autoincrement())` (a per-table
  Postgres sequence). A `NumberingSeries` model exists but is **unused** → vouchers reuse
  the autoincrement pattern (not NumberingSeries).
- Treasury accounts are already tagged (Phase 4B-0); vouchers reference a GL treasury account.

## 1. Voucher status lifecycle — `DRAFT → POSTED → REVERSED`
- **DRAFT:** editable, hard-deletable (no GL yet).
- **POSTED:** journal posted through the PostingEngine; immutable.
- **REVERSED:** GL entry reversed via ReversalService; original journal link retained,
  reversal link stored.
- **No CANCELLED** — drafts are deleted, posted vouchers are reversed (posted-record immutability).
- Delete rule: DRAFT deletable; POSTED/REVERSED → blocked (`use_reverse_instead`).

## 2. Proposed models
- **ReceiptVoucher** — number, date, branch, customer, treasury account, amount, reference, memo,
  status, period, journal + reversal links, created/posted/reversed actors + timestamps.
  Accounting at post: `Dr Treasury / Cr AR_CONTROL [CUSTOMER party]`.
- **PaymentVoucher** — mirror with supplier instead of customer.
  Accounting at post: `Dr AP_CONTROL [SUPPLIER party] / Cr Treasury`.
- **New enum** `VoucherStatus { DRAFT, POSTED, REVERSED }`.

## 3. Allocation model — two explicit tables (recommended)
`ReceiptVoucherAllocation` (receipt → sales invoice, amount) and
`PaymentVoucherAllocation` (payment → purchase invoice, amount).
- **Why:** all FKs NOT NULL (strong integrity), clean relations, **no CHECK constraints** needed,
  and it inherently enforces "receipt→sales, payment→purchase". (The single-table-with-nullable-FKs
  alternative is weaker and needs raw-SQL CHECKs.)
- **Rules (service-enforced):** optional; Σ(allocations) ≤ voucher amount; receipt allocations only
  to same-customer sales invoices; payment allocations only to same-supplier purchase invoices;
  same branch, single currency; retained after reversal; no allocation to cancelled/reversed
  invoices; partial + multi-invoice supported. DB enforces `unique(voucher, invoice)`.

## 4. Numbering
`voucherNumber BigInt @unique @default(autoincrement())` per model → separate, concurrency-safe
receipt/payment sequences, no reuse after reversal/delete. Global (not per-branch). Human-readable
`RV-YYYY-#####` / `PV-YYYY-#####` formatted in the API/UI layer.

## 5. PostingEngine compatibility
No engine changes: source types already exist; idempotency keys `RECEIPT_VOUCHER:<id>` /
`PAYMENT_VOUCHER:<id>`; ReversalService already handles any posted entry. Posting enforces treasury
validity (leaf/active/`is_cash_or_bank`/CASH-or-BANK/not AR-AP-control), the party requirement on
AR/AP control (roles live), and an OPEN period.

## 6. Migration risk — LOW (single additive migration)
New enum + 4 new tables + indexes/FKs + 2 sequences. No legacy edits, no destructive change, no
backfill, no data migration — safe on production (empty new tables, unread until the endpoints ship).

## 7. Indexes & constraints
Unique voucher number per table; `unique(voucher, invoice)` per allocation; indexes on
customer/supplier, `(branch, date desc)`, `status`, and the allocation's invoice; allocation FKs
cascade from their voucher and restrict to the invoice.

## 8. Permissions (recommendation)
Draft create/update/delete: OWNER / ACCOUNTANT / BRANCH_MANAGER (branch-scoped). Post: OWNER /
ACCOUNTANT. Reverse: OWNER / ACCOUNTANT. Read: any authenticated. WAREHOUSE must not post vouchers.
(No `CASHIER` role exists today; adding one is a separate, optional enum decision.)

## 9. Proposed implementation split
- **4B-1a:** schema + `VoucherStatus` enum + additive migration (+ `prisma generate`, build,
  migration-apply test).
- **4B-1b:** shared Zod request/response schemas + types (create/update/post/reverse/list/allocation).
- Endpoints are Phase 4B-2 (receipt) / 4B-3 (payment), out of 4B-1.

## 10. Test plan (later implementation)
Migration applies; number uniqueness/monotonicity; draft CRUD with no journal; invalid-treasury
rejection; customer/supplier required; allocation total + ownership guards; reject alloc to
cancelled/reversed invoice; POST → balanced journal with party in an open period, idempotent;
REVERSE → original retained + mirror linked; no legacy writes; no journal on draft-only ops.

## 11. Legacy compatibility (4B-1)
Schema-only. No legacy-table edits, no dual-write, no report migration, no write-freeze — those are
Phase 4C.

## Confirmations
- ✅ No schema/code/DB changes · ✅ read-only · ✅ no migration/generate/deploy.
