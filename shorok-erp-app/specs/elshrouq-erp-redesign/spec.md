# Feature Specification: Elshrouq ERP Redesign — Configurable Accounting & Inventory Product

**Feature Branch**: `elshrouq-erp-redesign`
**Created**: 2026-07-07
**Status**: Approved for planning (Ahmed Attia, 2026-07-07) — implementation NOT yet approved
**Constitution**: v2.0.0 (Principles I–VIII apply; VI–VIII ratified for this feature)

**Companion artifacts (this directory)**: `client-spec-ar.md` (client-facing, Arabic) · `client-questions.md` · `glossary-ar-en.md` · `technical-spec-en.md` · `admin-configuration.md` · `ui-ux-spec.md` · `design-system.md` · `plan.md` · `tasks.md`

## Problem Statement

The accounting layer added after baseline commit `75b9b70` (80 commits, June 20 – July 6 2026) was built without a posting architecture. Verified defects: purchase invoices write movement rows but never update stock balances (InventoryEngine bypassed); purchase postings can be unbalanced (no Σdebit==Σcredit assertion); sales-invoice GL posting and stock decrement are optional user checkboxes; COGS is a hand-typed value defaulting to 0; four parallel financial subsystems disagree (GL, CustomerTransaction, FactoryLedgerEntry with stored running balances, Payment/PaymentAccount with no GL link); money is referenced by name strings; VAT is one liability account at a wrong rate in places; journal entries are hard-deletable; there are no financial periods; client-specific data is hardcoded. The client (and their finance manager) rejected this quality. The redesign replaces the posting layer and productizes the system per Constitution VIII.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Trading cycle with trustworthy books (Priority: P1)

An accountant posts a purchase invoice (stock and supplier balance and input VAT update atomically, item average cost recalculates), then posts a sales invoice (stock validated and decremented, revenue + output VAT + COGS posted automatically from system cost), collects from the customer via a receipt voucher allocated to open invoices, pays the supplier via a payment voucher, and records an expense. The P&L, both statements, the VAT report, and the trial balance reflect all of it immediately with zero manual journal work.

**Acceptance**: end-to-end Playwright test of this exact cycle; every figure traceable by drill-down to journal lines; trial balance balanced throughout.

### User Story 2 — Corrections without rewriting history (Priority: P1)

A posted invoice was wrong. The accountant reverses it (mandatory reason); a linked reversal entry restores stock and balances. The original document, its journal entry, and its printed form never change. A closed month rejects new postings; only OWNER can reopen it, with a reason, audited.

**Acceptance**: no API path edits or deletes posted financial data; reversal round-trips stock and GL to the pre-posting state; period-lock test.

### User Story 3 — New company onboarding without code (Priority: P2)

An Otonom engineer provisions a fresh database for a new client company. The client admin completes the 10-step setup wizard (company profile & branding, branches/warehouses, COA template, posting profile confirmation, tax profile, banks/vaults, users, items, parties, opening balances gated by a balanced trial-balance check) and goes live. No code, seed, or migration edits specific to that client.

**Acceptance**: a second demo tenant is fully operational in under one day using only the wizard and per-tenant seed pack.

### User Story 4 — Policy changes forward, never backward (Priority: P2)

VAT rate changes by law. OWNER adds a new tax-profile version with an effective date. New invoices use the new rate; old invoices, reprints, and the VAT report for past periods keep the original rate. The same effective-date behavior applies to posting-profile and costing changes (costing additionally gated by a controlled-migration flow).

**Acceptance**: rate-change test — post, change config, reprint old + post new, assert both correct; config change rows appear in the audit trail with before/after snapshots.

### Edge Cases

- Posting into a period that closes between draft and post → rejected with a period error, draft preserved.
- Concurrent posts against the same item/balance → serialized by row locks; entry numbers unique via sequences (no count()+1).
- Receipt amount exceeding open invoices → remainder stays unallocated on account (على الحساب).
- Reversal of an invoice whose stock has since been partially sold → allowed only if resulting stock ≥ 0, else rejected with a clear error.
- Opening-balance re-import after go-live → requires reversal of the prior opening set; never overwrites.
- Deactivating a warehouse with stock, an account with lines, a party with balance → blocked with guard messages.

## Requirements *(mandatory)*

### Functional Requirements

**Posting core**
- **FR-001**: A single PostingEngine creates all journal entries; direct journal writes elsewhere are lint-blocked. Every entry: balanced, atomic with its document + inventory + audit, in an OPEN period, numbered by DB sequence, idempotency-keyed.
- **FR-002**: All stock changes go through the existing InventoryEngine (fixing the purchase-invoice bypass); a movement row and its balance effect are inseparable.
- **FR-003**: Document lifecycle DRAFT → POSTED → REVERSED; posted docs immutable; reversal entries linked via `reversal_of_id` with mandatory reason.
- **FR-004**: Monthly financial periods with close/reopen (reopen OWNER-only, audited).
- **FR-005**: Customer/supplier subledgers = AR/AP control accounts + `party_type/party_id` on journal lines. Legacy parallel ledgers (CustomerTransaction, FactoryLedgerEntry, Payment/PaymentAccount) are migrated to GL and removed. No stored running balances anywhere.
- **FR-006**: Cash boxes and bank accounts are GL leaf accounts flagged `is_cash_or_bank`; treasury documents move money only through them.

**Documents**
- **FR-010**: Purchase invoice post = Dr Inventory + Dr VAT-In / Cr AP[party] + engine RECEIPT movements + weighted-average cost update, one transaction, accounts from posting profile (zero user account pickers).
- **FR-011**: Sales invoice post = stock validation (hard block on shortage), Dr AR[party] / Cr Revenue + Cr VAT-Out, plus Dr COGS / Cr Inventory at system average cost (never user-entered), engine SALE movements. `unit_cost_at_posting` stamped per line.
- **FR-012**: Receipt voucher (سند قبض) and payment voucher (سند صرف): numbered printable documents, treasury account selection, FIFO-default editable allocation against open invoices, remainder on account.
- **FR-013**: Expenses post via category→account mapping (mandatory posting), payment from treasury or on-credit supplier, optional input VAT.
- **FR-014**: Sales/purchase returns (credit/debit notes) are in v1.0 scope, mirroring their invoices including stock and cost effects.
- **FR-015**: Invoice-level discount with discount-account mapping (line-level deferred unless client confirms need).

**Configuration & productization**
- **FR-020**: Admin Configuration module per `admin-configuration.md`: 18 areas, two tiers (onboarding wizard + settings), effective-date versioning for posting-affecting config, audit on every change, permission-gated (accounting config = ACCOUNTANT/OWNER; posting profile, costing, period reopen = OWNER).
- **FR-021**: No client-specific values in code (Constitution VIII list); Elshrouq's catalog moves to its tenant seed pack; boards/meters become a configurable UoM pair with conversion factor.
- **FR-022**: Company branding (name, logo, primary color) from CompanyProfile drives UI tokens and print templates; currency locked after first posting.
- **FR-023**: Document numbering series per document type (prefix, padding, next-number, optional fiscal-year reset, optional per-branch).

**Reports** (all read posted journal lines / stock movements only)
- **FR-030**: Dynamic general ledger (account/party/treasury/category filters, opening + running + closing balance), customer/supplier statements, AR/AP aging from open items minus allocations, trial balance, balance sheet, P&L with drill-down, VAT report (output − input per filing period), inventory balance with valuation reconciling to the Inventory GL account (CI-tested invariant), stock movement, cash/bank movement.

**Migration**
- **FR-040**: Expand-and-contract migration converting legacy ledgers into opening balances + GL history per client decisions; dry-run reconciliation (old balances == derived balances) must be zero-diff before production run.

### Key Entities

New: `CompanyProfile`, `FinancialPeriod`, `PostingProfile` (versioned), `TaxProfile` (versioned), `ExpenseCategory`, `Warehouse`, `ReceiptVoucher`, `PaymentVoucher`, `VoucherAllocation`, `SalesReturn`, `PurchaseReturn`, `NumberingSeries`, `PrintTemplate` (versioned).
Modified: `JournalEntry` (+status, period, reversal link, typed source), `JournalLine` (+party/branch dimensions), `Account` (+is_cash_or_bank, system_role), `ProductVariant` (+avg_cost, UoM config), invoices (−account columns, +period/posted metadata), `CustomerOrder` (+customer FK), `Expense` (+category/treasury FKs).
Removed after migration: `CustomerTransaction`, `FactoryLedgerEntry`, `Payment`, `PaymentAccount`.
Full field detail: `technical-spec-en.md` §Data Model + `admin-configuration.md`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The User-Story-1 cycle completes with zero manual journal entries and zero account pickers; every report figure drills down to source.
- **SC-002**: Trial balance balances and inventory valuation reconciles to GL after any CI property-test posting sequence.
- **SC-003**: Migration dry-run reconciliation on the client snapshot = zero diff, signed off by the finance manager.
- **SC-004**: No API endpoint can edit/delete posted financial data (verified by tests).
- **SC-005**: A second demo tenant provisioned in < 1 day with no code changes.
- **SC-006**: Grep gates in CI: no direct journal writes outside the engine; no client-specific literals in code; no direction-specific Tailwind utilities; no hardcoded UI strings.

## Assumptions (Recommended Assumptions log — RA-1 … RA-10)

RA-1 Egyptian-market Arabic glossary (ratified in `glossary-ar-en.md`) · RA-2 VAT 14% default via versioned tax profiles, per-line rate snapshot at posting · RA-3 moving weighted-average costing (FIFO reserved) · RA-4 one GL, control accounts + party dimensions, Egyptian trading COA template · RA-5 four roles (OWNER, ACCOUNTANT, SALES, STORE); definitions in code, assignments in config · RA-6 two-tier configuration model with effective-date versioning only where posting-affecting · RA-7 single-tenant-per-DB, CompanyProfile from day 1, brand tokens, tenant seed packs · RA-8 returns + invoice-level discounts in v1.0 · RA-9 numbering series pattern (prefix + padded counter + optional yearly reset) · RA-10 UI/UX per `ui-ux-spec.md`.

## Client Confirmation Needed (blocking items only)

1. Opening-balance cut-over date + authoritative figures (customers, suppliers, banks, vaults, stock).
2. Physical stock count feasibility at cut-over.
3. VAT registration status; any exempt items; filing cycle.
4. History migration depth: full 2026 history into GL vs opening balances + go-forward.

Non-blocking client inputs (returns frequency, discounts practice, user list, print sample, extra reports, EN locale need) are configuration/onboarding data — see `client-questions.md`.

## Out of Scope (v1.0)

Multi-currency; cost centers as first-class module (branch dimension reserved on lines); custom role builder; bank reconciliation; e-invoicing (ETA) integration; SaaS multi-tenancy in one DB; POS; HR/payroll. Each requires a new spec cycle.
