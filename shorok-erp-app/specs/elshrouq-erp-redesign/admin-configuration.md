# Admin Configuration / Product Settings Architecture

**Feature**: elshrouq-erp-redesign · **Constitution**: Principle VIII

**Product principle (ratified):** Elshrouq ERP is a **configurable product**. Every client-specific value lives in one of two places — **onboarding setup data** (entered once when a company is provisioned, via a setup wizard) or **admin configuration** (editable later from Settings by authorized roles). Nothing client-specific is code.

**Effective-date framework:** configuration that affects posting carries `effective_from` (and versioned rows). The engine resolves config **as of the document's posting date**. Consequences, uniformly applied:
- Posted documents are never rewritten by config changes — they permanently store the resolved values used at posting time (`tax_rate_at_posting`, `unit_cost_at_posting`, account ids inside journal lines, print snapshot data).
- VAT rate change → new `tax_profile` version with `effective_from`; old invoices keep stored rate.
- Account-mapping change → new `posting_profile` version; historical journal lines untouched.
- Costing method change → blocked unless: no open drafts + effective date ≥ last posting date + explicit OWNER confirmation; creates an audit event and a valuation snapshot (controlled migration).
- Branding change → live screens use current branding; printed documents policy is configurable: `print_branding = CURRENT | AS_POSTED` (default CURRENT; archived snapshot supported for tax-sensitive docs).
- All configuration writes go through the existing AuditService (before/after snapshot, actor, timestamp).

**Configuration areas** *(Editors: O=OWNER, A=ACCOUNTANT, M=STORE/branch manager; validation = key rules; Impact: F=future postings only, S=structural/master data)*

| Area | Purpose / key fields | Edit | Validation & impact rules |
|---|---|---|---|
| CompanyProfile | name AR/EN, logo, primary color, currency, tax reg no, fiscal-year start, default locale, print footer | O | Currency locked after first posting (F/S). Branding F (see print policy) |
| Branches | name keys, address, active | O | Deactivate only if no open documents (S) |
| Warehouses | name keys, branch link, active | O, A | Deactivate requires zero stock (S) |
| Customers / Suppliers | code, names, phone, tax id, credit limit, opening balance ref | O, A (create: also SALES for customers) | Opening balance only via opening entry; delete → deactivate only (S) |
| Items & UoM | sku, names, category, uom_base, uom_alt + conversion factor, default prices, price tolerance %, active | O, A | UoM conversion locked once movements exist; new UoM = new effective config (S) |
| Banks & Cash Vaults | GL account (auto-created under treasury parent), type CASH/BANK, bank meta, per-user default vault | O, A | Must map to leaf account flagged is_cash_or_bank; deactivate requires zero balance (S) |
| Chart of Accounts | tree CRUD, account types | O, A | system_role accounts undeletable/untypable; no delete with lines — deactivate; no type change once posted to (S) |
| Posting Profile | purpose→account map (AR, AP, revenue, COGS, inventory, VAT in/out, discount, rounding, retained earnings, shrinkage) | **O only** | Versioned + effective_from; all slots mandatory before first posting — setup wizard enforces (F) |
| Tax Profiles | name, rate %, input/output accounts, registration status, filing cycle | O | Versioned + effective_from (F). Per-item override table optional (client Q5) |
| Costing Settings | method (WAC v1; FIFO reserved), recalc tools | **O only** | Change = controlled migration (above) (F+S) |
| Expense Categories | name keys → account map, taxable default | O, A | Category deactivation hides from new expenses only (F) |
| Document Numbering | per doc-type series: prefix, next number, padding, reset-per-fiscal-year, per-branch series toggle | O | Series change never renumbers existing docs; gaps allowed & logged (F) |
| Print Templates | per doc-type: shown fields toggles, footer text, signature slots, paper size, branding policy | O, A | Template versions retained for reprint fidelity (F) |
| Users & Roles | users, role assignment, branch access, per-user default vault/warehouse, locale | O | Permission map itself is code-defined (see H-risks); assignment is config (S) |
| Financial Periods | monthly grid, close/reopen, closing checklist | close: A/O · reopen: **O only** | Reopen requires reason; all period actions audited (F) |
| Localization | per-user locale, company default, date/number formats | user/O | UI-only; no posting impact (F) |
| Opening Balances (wizard) | cut-over date, per-party balances, per-item qty+cost, per-treasury balances | O+A during onboarding | Generates OPENING entries via engine; re-running requires reversal of prior opening set (S) |

**Setup wizard (new-company onboarding)** — ordered, resumable, maps 1:1 to client questions: ① CompanyProfile → ② Branches & Warehouses → ③ COA template choice (Egyptian trading default, editable) → ④ Posting profile (pre-filled from template, confirm) → ⑤ Tax profile → ⑥ Banks/vaults → ⑦ Users & roles → ⑧ Items import → ⑨ Parties import → ⑩ Opening balances + trial-balance check (must balance to proceed) → go-live. Each step = the same Settings screen in "wizard mode" — zero duplicated UI.

**Tenant seed pack:** provisioning a new company = empty DB + migrations + COA template + default expense categories + default numbering + default print template. No Elshrouq data in any seed used for other tenants; Elshrouq's own catalog (paint SKUs, ميجا بوند, board UoM pair) moves to *its* tenant seed only.
