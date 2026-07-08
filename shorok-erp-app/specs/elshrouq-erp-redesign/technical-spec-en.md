# Elshrouq ERP — Technical Implementation Specification (EN)

**Audience:** Claude Code / Codex / developers · **Status:** DRAFT awaiting approval · **Companion docs (same directory):** spec.md · client-spec-ar.md · ui-ux-spec.md · design-system.md · glossary-ar-en.md · admin-configuration.md
**Terminology note:** Arabic UI terms in this document come from the ratified glossary (§C below). Business logic must reference i18n keys, never literal Arabic strings.

---

## F. Technical Implementation Specification

### F.1 Architecture decisions (ratified unless Ahmed overrides)

| # | Decision | Rationale |
|---|---|---|
| A1 | Keep monorepo: Next.js 14 App Router + NestJS + Prisma + PostgreSQL, pnpm + Turborepo | Working, tested, team knows it |
| A2 | Keep hand-written SQL migrations (no `prisma migrate dev`), expand-and-contract pattern | Existing discipline; safe on live data |
| A3 | **Single PostingEngine service** — the only code allowed to write `journal_entries`; ESLint rule bans `journalEntry.create` outside it | Kills the root cause of the silo problem |
| A4 | Subledgers = GL control account + `party_id` dimension on lines (NOT separate tables) | One source of truth; statements/aging are queries |
| A5 | Cash/banks are GL accounts (`is_cash_or_bank=true`, `treasury_type`) | Kills PaymentAccount split-brain |
| A6 | Costing: moving weighted average, server-maintained on variant | Egyptian market default (client Q4 pending) |
| A7 | Posted documents immutable; corrections via reversal entries; monthly period locks | Audit requirement |
| A8 | Single-currency EGP v1; `Company` table from day 1 (one row) for branding/config | Productization without multi-tenant complexity |
| A9 | Warehouse decoupled from Branch (`warehouses` table; branch may have N warehouses) | Client Q7; product-generic |
| A10 | UoM: keep boards/meters for Elshrouq but as variant-level config (`uom_base`, `uom_alt`, `conversion_factor`) | De-hardcodes the domain |

**A10 naming-mismatch note (discovered in Phase 1 manual testing, 2026-07-08):** the paint-board business quantity is an **area in square metres (م²)** — a board has an area (كبير 5.25, صغير 4, or custom طول×عرض) and the line quantity is عدد الألواح × مساحة اللوح. However, existing columns/code still use **linear-metre naming** (`product_variants.size_meters_per_board`, invoice-line `metersQuantity`, the frontend `SIZE_*`/`metersQuantity` fields). This is a naming-only defect: the maths is correct, the labels were wrong. **Phase 1 corrected the UI labels only** (مساحة اللوح (م²) / إجمالي المساحة (م²)); the frontend sizing logic was extracted to a unit-tested pure helper (`apps/web/lib/purchase-sizing.ts`) that documents the mismatch. **Full rename/data-model cleanup is deferred to Phase 7 UoM migration (T090)** — do not assume "meters" means linear length anywhere in this catalog.
| A11 | i18n: all UI strings via next-intl keys; **zero Arabic literals in API business logic** — API returns message codes, web maps to glossary terms | Current code violates this everywhere; blocks EN locale |

### F.2 Database entities (target)

**New:** `companies` (branding, currency, tax profile ref, numbering prefs) · `financial_periods` (year, month, status OPEN/CLOSED, closed_by/at) · `posting_profiles` (singleton: ar/ap/revenue/cogs/inventory/vat_in/vat_out/rounding/retained_earnings account ids) · `tax_profiles` (name, rate, input_account_id, output_account_id, active) · `expense_categories` (name keys, account_id) · `warehouses` (branch_id?, name keys) · `receipt_vouchers` / `payment_vouchers` (number, date, party_id, treasury_account_id, amount, memo, status, journal_entry_id) · `voucher_allocations` (voucher_id, voucher_type, invoice_type, invoice_id, amount) · `sales_returns` / `purchase_returns` (v1.x, same shape as invoices).

**Modified:** `journal_entries` + status(POSTED/REVERSED), period_id, reversal_of_id, source_type (ENUM: SALES_INVOICE|PURCHASE_INVOICE|RECEIPT_VOUCHER|PAYMENT_VOUCHER|EXPENSE|ADJUSTMENT|DEPRECIATION|OPENING|MANUAL), source_id; number from DB sequence. · `journal_lines` + party_type?, party_id?, branch_id? · `accounts` + is_cash_or_bank, treasury_type?, system_role? (AR_CONTROL|AP_CONTROL|VAT_IN|VAT_OUT|INVENTORY|…; protected from delete/retype) · `product_variants` + avg_cost (server-only), cost_updated_at, uom config · `sales_invoices`/`purchase_invoices`: drop per-invoice account columns; + period_id, posted_at/by, warehouse_id; line cost → `unit_cost_at_posting` (server-stamped) · `customer_orders`: customer_id FK replaces name string · `expenses`: category_id FK + paid_from_account_id FK replace strings.

**Removed after migration:** `customer_transactions`, `factory_ledger_entries` (→ purchase invoices + payment vouchers), `payments`, `payment_accounts`, `order_collections.paid_to_account` string (collections → receipt vouchers).

### F.3 PostingEngine design

```ts
interface PostingRequest {
  sourceType: SourceType; sourceId: string;
  entryDate: Date;            // engine resolves + validates period
  memo: I18nKey; lines: PostingLine[];   // accountId, debit|credit, partyRef?, branchId?, noteKey?
  idempotencyKey: string;
}
// engine.post(tx, req) → { journalEntryId, entryNumber }
```
Invariants enforced inside `post()` — each is a thrown typed error + a DB constraint backstop:
1. Σdebit == Σcredit (also DB trigger)
2. every line: debit==0 XOR credit==0 (DB CHECK)
3. period OPEN for entryDate
4. all accounts leaf + active; party required when account has system_role AR/AP_CONTROL
5. amounts > 0, 2dp
6. entry number from sequence; idempotency key honored
7. audit row in same tx
`reverse(entryId, reason)` creates mirrored entry, links both, sets status REVERSED. **No delete path exists.**

### F.4 Document posting flows (normative Dr/Cr)

*(rate = active tax profile, default 14%; accounts from posting_profile — never from request payloads)*

**Purchase invoice POST:** Dr Inventory(subtotal) + Dr VAT-In(tax) / Cr AP-control[party=supplier](total) → InventoryEngine RECEIPT per line into invoice.warehouse → cost update per variant: `avg = (onHand*avg + qty*unitCost)/(onHand+qty)` under the same row lock.
**Sales invoice POST:** validate stock first (engine will also enforce). Entry 1: Dr AR-control[party=customer](total) / Cr Revenue(subtotal) + Cr VAT-Out(tax). Entry 2: Dr COGS / Cr Inventory at Σ(qty × avg_cost); stamp `unit_cost_at_posting`. InventoryEngine SALE per line.
**Receipt voucher POST:** Dr treasury account / Cr AR-control[party=customer]; allocations FIFO default (editable), Σallocations ≤ amount.
**Payment voucher POST:** Dr AP-control[party=supplier] / Cr treasury account; allocations same.
**Expense POST:** Dr category.account (+ Dr VAT-In if taxable) / Cr treasury OR Cr AP-control[party] (on-credit).
**Adjustment (count):** shortage Dr Shrinkage / Cr Inventory at avg cost; surplus mirrored.
**Depreciation:** Dr Depreciation Expense / Cr Accumulated Depreciation (reroute existing module through engine).
**Opening balances (migration tool):** OPENING entries; per-party lines on control accounts; per-variant stock via engine RECEIPT + avg_cost seed; Cr/Dr net to Opening Balance Equity.

### F.5 Validation rules (beyond engine invariants)

- Sales line qty > 0 and ≤ available in selected warehouse (pre-check + engine enforcement)
- Price tolerance: keep existing variant % tolerance + approval flow
- No posting to non-leaf or system-protected accounts from manual journal UI
- Voucher amount > 0; allocation cannot exceed invoice open balance
- Draft edits allowed only in DRAFT; number reserved at draft creation (per-type sequence)
- Backdating: allowed within OPEN periods only

### F.6 RBAC (permission map, centrally defined)

| Action | SALES | ACCOUNTANT | OWNER |
|---|---|---|---|
| Create/edit draft invoices & vouchers | ✅ | ✅ | ✅ |
| Post documents | ❌ | ✅ | ✅ |
| Reverse posted documents | ❌ | ✅ (same period) | ✅ |
| Manual journal entries | ❌ | ✅ | ✅ |
| Close/reopen period | ❌ | close | close+reopen |
| Posting configuration / COA edits | ❌ | ❌ | ✅ |
| View profit reports | ❌ | ✅ | ✅ |
| Users/roles/company settings | ❌ | ❌ | ✅ |

Single `PERMISSIONS: Record<Action, Role[]>` map consumed by guards; matrix doc auto-generated. (Client Q10 may adjust.)

### F.7 Report data sources

Every financial figure = query over `journal_lines` joined to posted `journal_entries` (+ inventory tables for qty). Opening balance = Σ(lines < from). Running balance computed in SQL window function. Aging = open invoices − allocations, bucketed on due_date. Valuation report must reconcile Σ(qty×avg_cost) with the Inventory GL balance — a CI-tested invariant. No report reads document tables for money (documents are for drill-down metadata only).

### F.8 API design

Consistent document endpoints: `POST /x` (draft) · `PUT /x/:id` (draft only) · `POST /x/:id/post` · `POST /x/:id/reverse` · `GET /x?status&party&period&cursor`. Reports under `/reports/*` accepting `{from,to,accountId?,partyType?,partyId?,warehouseId?,branchId?}`. Settings: `/settings/posting-profile`, `/settings/tax-profiles`, `/settings/expense-categories`, `/settings/periods`, `/settings/company`. All POSTs idempotency-keyed (existing pattern). Errors: typed codes + params, localized client-side.

### F.9 Migration strategy (expand-and-contract)

1. Expand: new tables/columns, nullable
2. Backfill: map name-strings → FKs (collections, expenses, orders.customer)
3. Convert: FactoryLedger → purchase invoices + payment vouchers; Payments/CustomerTransactions → vouchers/GL history or opening balances (per client Q1/Q8)
4. Reconcile: assert old stored balances == new derived balances per party/account; produce diff report for accountant sign-off
5. Switch reads, freeze old writes
6. Contract: drop legacy tables
Each step = one SQL migration + rollback note; dry-run on sanitized client dump is a phase gate.

### F.10 Testing strategy

- **Engine unit tests:** each invariant (unbalanced→reject, closed period→reject, negative stock→reject, idempotent repost→noop)
- **Golden-path integration tests:** each F.4 flow asserts exact Dr/Cr rows + stock delta + avg_cost
- **Property test:** random posting sequences ⇒ trial balance always balances; valuation always reconciles
- **Migration test:** run pipeline on client-data snapshot; reconciliation must be zero-diff
- **E2E (Playwright):** the client's cycle — purchase→stock up→sell (blocked when short)→receipt→payment→P&L shows correct net
- CI gate: no PR merges with engine or reconciliation tests red

---


*Roadmap/phases: see `plan.md`. Admin configuration architecture: see `admin-configuration.md`. Glossary: see `glossary-ar-en.md`.*
