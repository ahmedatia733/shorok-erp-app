# API Contract Delta — elshrouq-erp-redesign

Base: `/api/v1`. Existing conventions kept (JWT bearer, Zod validation from `packages/shared`, idempotency keys on POST, cursor pagination, typed error codes localized client-side). This file lists the delta against `specs/main/contracts/`; unchanged endpoints are not repeated. Full OpenAPI regeneration is a Phase-2 task.

## Document lifecycle pattern (applies to: sales-invoices, purchase-invoices, sales-returns, purchase-returns, receipt-vouchers, payment-vouchers, expenses)

| Method & path | Roles | Notes |
|---|---|---|
| `POST /{doc}` | SALES+ (drafts) | Create DRAFT; number reserved from numbering_series |
| `PUT /{doc}/:id` | SALES+ | DRAFT only; 409 `document_not_draft` otherwise |
| `POST /{doc}/:id/post` | ACCOUNTANT+ | Runs PostingEngine; returns `{journalEntryIds[], entryNumbers[]}`; errors: `period_closed`, `insufficient_stock` (per-line detail), `posting_profile_incomplete`, `unbalanced` (should be impossible → 500-class) |
| `POST /{doc}/:id/reverse` | ACCOUNTANT+ (same period), OWNER | Body `{reason}` mandatory; creates linked reversal |
| `GET /{doc}` | role-scoped | Filters: `status, partyId, periodId, from, to, warehouseId, cursor` |
| `GET /{doc}/:id` | role-scoped | Includes posting preview data + journal links when POSTED |
| ~~`DELETE /{doc}/:id`~~ | — | **Removed for posted docs everywhere** (DRAFT delete allowed, audited) |

Removed endpoints: `DELETE /journal/:id` (all statuses) · `POST /payments` · `GET/POST /payment-accounts` · order-collections write path (replaced by receipt vouchers with `orderId`).

## Posting preview

`POST /{doc}/:id/preview` → `{entries: [{memo, lines: [{accountId, accountName, debit, credit, party?}]}], inventoryEffects: [{warehouseId, variantId, delta, resulting}], balanced: true}` — same resolution code path as posting, no writes. ACCOUNTANT+.

## Vouchers & allocations

`POST /receipt-vouchers` body: `{customerId, treasuryAccountId, amount, voucherDate, reference?, memo?, orderId?, allocations?: [{invoiceType, invoiceId, amount}]}` — omitted allocations = auto-FIFO server-side; response echoes final allocation set.
`GET /parties/:type/:id/open-items` → open invoices with `openBalance` per item (feeds allocation UI + aging).

## Configuration module (`/settings/*`)

| Path | Roles | Versioning |
|---|---|---|
| `GET/PUT /settings/company` | GET: ACCOUNTANT+ · PUT: OWNER | currency 409 `currency_locked` after first posting |
| `GET/POST /settings/posting-profiles` | OWNER | POST = new version `{effectiveFrom, ...accountIds}`; GET returns version history |
| `GET/POST /settings/tax-profiles` | ACCOUNTANT+ (POST: OWNER) | versioned, same pattern |
| `GET/POST/PUT /settings/expense-categories` | ACCOUNTANT+ | plain CRUD + audit |
| `GET/PUT /settings/costing` | OWNER | PUT runs guarded change flow; 409 `open_drafts_exist`, `effective_date_before_last_posting` |
| `GET/POST/PUT /settings/numbering-series` | OWNER | never renumbers issued docs |
| `GET/POST /settings/print-templates` | ACCOUNTANT+ | versioned |
| `GET/POST /settings/warehouses`, `/branches` | OWNER (A: warehouses) | deactivation guards: `warehouse_has_stock`, `branch_has_open_documents` |
| `GET/POST /settings/periods` + `POST /settings/periods/:id/close|reopen` | close: ACCOUNTANT+ · reopen: OWNER | close returns checklist result; reopen body `{reason}` |
| `GET /settings/permissions` | any authenticated | read-only permission matrix (generated from code map) |
| Setup wizard | OWNER | `GET /setup/status` (step completion), each step = the settings endpoints above; `POST /setup/opening-balances/dry-run|commit` (two-phase, returns trial-balance check) |

## Reports (all read posted journal lines / movements only)

`GET /reports/ledger?accountId|partyType+partyId|treasuryOnly&from&to&branchId` → `{opening, entries[{date, docRef{type,id,number}, memo, debit, credit, running}], totals, closing}`
`GET /reports/statement/:partyType/:partyId?from&to` → ledger shape + aging chips + open items
`GET /reports/aging/:partyType?asOf` · `GET /reports/trial-balance?asOf` · `GET /reports/balance-sheet?asOf` · `GET /reports/income-statement?from&to` (per-category expense breakdown, drill-down ids) · `GET /reports/vat?periodId|from&to` → `{outputVat, inputVat, netPayable, detail per doc}` · `GET /reports/inventory-balance?warehouseId` → rows + `{totalValue, glInventoryBalance, reconciled: bool}` · `GET /reports/stock-movements?variantId&warehouseId&type&from&to` · `GET /reports/cash-bank?treasuryAccountId&from&to`

## Error codes (new)

`period_closed, document_not_draft, insufficient_stock, posting_profile_incomplete, currency_locked, warehouse_has_stock, account_is_system, party_required_on_control_account, allocation_exceeds_open_balance, open_drafts_exist, effective_date_before_last_posting, reversal_would_negate_stock`
All returned as `{code, params}`; Arabic/English messages resolved client-side from the glossary-consistent catalogs.
