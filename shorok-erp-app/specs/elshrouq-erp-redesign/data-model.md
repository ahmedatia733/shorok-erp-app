# Data Model — elshrouq-erp-redesign

**Input**: spec.md Key Entities + technical-spec-en.md §F.2 + admin-configuration.md
**Convention**: snake_case DB columns via Prisma `@map`; all money `NUMERIC(14,2)`; all ids UUID; timestamps `timestamptz`. ✏️ = modified existing table, ⭐ = new, 🗑 = removed after migration.

## Core accounting

### ⭐ company_profile (single row per tenant DB)
`id, name_ar, name_en, logo_url?, brand_primary_color?, currency CHAR(3) DEFAULT 'EGP', currency_locked_at?, tax_registration_no?, fiscal_year_start_month INT (1–12), default_locale, print_footer_ar?, print_footer_en?, print_branding_policy ENUM(CURRENT, AS_POSTED) DEFAULT CURRENT, created_at, updated_at`
Rules: currency immutable once `currency_locked_at` set (first posting stamps it).

### ⭐ financial_periods
`id, year INT, month INT (1–12), status ENUM(OPEN, CLOSED), closed_by?, closed_at?, reopened_by?, reopened_at?, reopen_reason?` — UNIQUE(year, month)
Transitions: OPEN→CLOSED (ACCOUNTANT/OWNER, pre-close checklist), CLOSED→OPEN (OWNER + reason, audited). PostingEngine rejects entries whose entry_date falls in a non-OPEN period.

### ✏️ accounts
Existing tree kept. Add: `is_cash_or_bank BOOL DEFAULT false, treasury_type ENUM(CASH, BANK)?, bank_meta JSONB?, system_role ENUM(AR_CONTROL, AP_CONTROL, VAT_INPUT, VAT_OUTPUT, INVENTORY, COGS, REVENUE, DISCOUNT, ROUNDING, RETAINED_EARNINGS, OPENING_EQUITY, SHRINKAGE)?`
Rules: system_role accounts cannot be deleted, deactivated, or re-typed; only leaf+active accounts postable; type change forbidden once account has lines.

### ✏️ journal_entries
Add: `status ENUM(POSTED, REVERSED) DEFAULT POSTED, period_id FK→financial_periods, reversal_of_id FK→journal_entries?, source_type ENUM(SALES_INVOICE, PURCHASE_INVOICE, SALES_RETURN, PURCHASE_RETURN, RECEIPT_VOUCHER, PAYMENT_VOUCHER, EXPENSE, ADJUSTMENT, DEPRECIATION, OPENING, MANUAL), source_id UUID?`
`entry_number` stays `BIGINT autoincrement` — **the only number source; count()+1 forbidden**. Remove: hard-delete endpoint (schema unchanged, API change). DB trigger: per-entry Σdebit == Σcredit deferred-check.

### ✏️ journal_lines
Add: `party_type ENUM(CUSTOMER, SUPPLIER)?, party_id UUID?, branch_id FK?`
DB CHECK: `(debit = 0) <> (credit = 0)` (exactly one side non-zero). Index: `(account_id, party_type, party_id, id)`; supporting index on `journal_entries(entry_date, period_id)` for date-ordered scans.
Rule: lines on accounts with system_role AR_CONTROL/AP_CONTROL MUST carry party ref (engine-enforced).

## Configuration (versioned where posting-affecting)

### ⭐ posting_profiles (versioned)
`id, effective_from DATE, ar_account_id, ap_account_id, revenue_account_id, cogs_account_id, inventory_account_id, vat_input_account_id, vat_output_account_id, discount_account_id, rounding_account_id, retained_earnings_account_id, opening_equity_account_id, shrinkage_account_id, created_by, created_at`
Resolution: engine picks the row with max(effective_from ≤ posting date). All slots mandatory before first posting (wizard gate). Edit = new version row; OWNER only.

### ⭐ tax_profiles (versioned)
`id, name_key, rate NUMERIC(5,2), input_account_id, output_account_id, registration_status ENUM(REGISTERED, NOT_REGISTERED), filing_cycle ENUM(MONTHLY, QUARTERLY), effective_from DATE, active, created_by, created_at`
Same resolution rule. Documents snapshot the resolved rate per line at posting (`tax_rate_at_posting`).

### ⭐ expense_categories
`id, name_ar, name_en, account_id FK→accounts, taxable_default BOOL, active`

### ⭐ numbering_series
`id, document_type ENUM(...same as source_type minus MANUAL/OPENING...), prefix VARCHAR(10), pad_width INT DEFAULT 5, next_number BIGINT, reset_yearly BOOL, per_branch BOOL, branch_id?` — UNIQUE(document_type, branch_id, fiscal-year window)
Rule: numbers issued inside the posting transaction via `SELECT … FOR UPDATE`; never renumber issued documents; gaps permitted and logged.

### ⭐ print_templates (versioned)
`id, document_type, version INT, field_toggles JSONB, footer_ar?, footer_en?, signature_slots JSONB, paper ENUM(A4, A5_LANDSCAPE), branding_policy ENUM(CURRENT, AS_POSTED), effective_from, active`
Posted documents store `print_template_version` for reprint fidelity.

### ⭐ costing_settings (single row, guarded)
`id, method ENUM(WAC) DEFAULT WAC /* FIFO reserved */, effective_from DATE, changed_by, valuation_snapshot_url?`
Change flow (OWNER): no open drafts + effective_from ≥ last posting date + confirmation → audit + snapshot.

### ⭐ warehouses
`id, branch_id FK?, name_ar, name_en, active` — replaces branch-as-warehouse conflation. `branch_inventory_balances` and `inventory_movements` gain `warehouse_id` (migration backfills 1:1 from branch).

## Documents

### ✏️ sales_invoices / purchase_invoices
Drop: per-invoice account-id columns (accounts come from posting profile). Add: `warehouse_id FK, period_id FK, posted_at?, posted_by?, status ENUM(DRAFT, POSTED, REVERSED), reversal_of_id?, number VARCHAR (from numbering_series), discount_amount NUMERIC(14,2) DEFAULT 0`
Lines: `unit_cost_at_posting NUMERIC(14,2)?` (server-stamped, sales only), `tax_rate_at_posting NUMERIC(5,2)?`; user-entered costPrice removed.

### ⭐ sales_returns / purchase_returns
Same shape as their invoices + `original_invoice_id FK?`. Posting mirrors the invoice with opposite signs (stock back in at original `unit_cost_at_posting` where linked; else current avg cost).

### ⭐ receipt_vouchers / payment_vouchers
`id, number, voucher_date DATE, party_id FK (customer|supplier resp.), treasury_account_id FK→accounts(is_cash_or_bank), amount, reference?, memo?, status ENUM(DRAFT, POSTED, REVERSED), period_id, journal_entry_id?, posted_at?, posted_by?, created_by`

### ⭐ voucher_allocations
`id, voucher_type ENUM(RECEIPT, PAYMENT), voucher_id, invoice_type ENUM(SALES_INVOICE, PURCHASE_INVOICE, SALES_RETURN, PURCHASE_RETURN), invoice_id, amount` — Σ per voucher ≤ voucher.amount; Σ per invoice ≤ invoice open balance (checked in posting tx).

### ✏️ expenses
Replace `paid_from_account VARCHAR` → `paid_from_account_id FK→accounts | ap supplier party`; add `category_id FK→expense_categories, taxable BOOL, status/period/posted metadata` as invoices. `gl_account_id/payment_gl_account_id` columns dropped (derived from category + treasury).

### ✏️ product_variants
Add: `avg_cost NUMERIC(14,4) DEFAULT 0, cost_updated_at?, uom_base VARCHAR(20), uom_alt VARCHAR(20)?, uom_conversion NUMERIC(12,4)?` (boards/meters becomes uom config; `size_meters_per_board` migrates into `uom_conversion`).
Rule: avg_cost server-maintained only, updated under the same row lock as the balance row.

### ✏️ customer_orders
`customer_name VARCHAR` → `customer_id FK→customers` (migration maps names, unmatched → created customers flagged for review). Collections flow replaced by receipt vouchers linked to orders (`order_id?` on receipt_vouchers).

## 🗑 Removed after Phase-4 migration
`customer_transactions` (→ GL party lines / opening balances) · `factory_ledger_entries` (→ purchase invoices + payment vouchers) · `payments` + `payment_accounts` (→ vouchers + treasury accounts) · `order_collections.paid_to_account` string column (collections → receipt vouchers).
Contract step drops tables only after the reconciliation gate (old stored balances == derived GL balances, zero diff, finance-manager sign-off).

## State machines

Document: `DRAFT → POSTED → REVERSED` (no other transitions; REVERSED is terminal; reversal creates the mirrored journal entry linked via reversal_of_id).
Period: `OPEN ⇄ CLOSED` (close: checklist; reopen: OWNER + reason).
