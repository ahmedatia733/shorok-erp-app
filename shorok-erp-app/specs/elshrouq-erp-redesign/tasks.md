# Tasks: Elshrouq ERP Redesign — Configurable Accounting & Inventory Product

**Input**: spec.md, plan.md, data-model.md, contracts/endpoints.md in `specs/elshrouq-erp-redesign/`
**Organization**: by ratified delivery phases 1–7 (per plan.md; overrides default story-phase layout at feature-owner instruction). Story labels map tasks to spec.md user stories: US1 trading cycle · US2 corrections/immutability · US3 onboarding · US4 effective-dated config.
**Test policy**: constitution v2.0.0 makes golden-path tests mandatory for every posting flow — each posting task is paired with its test task.
**⛔ EXECUTION GATE: No task in this file may be executed until Ahmed Attia explicitly approves implementation. Phase 1 additionally requires its own named approval.**
**Paths**: repo-relative from `shorok-erp-app/`. Script note: always run Spec Kit scripts with `SPECIFY_FEATURE=elshrouq-erp-redesign` (git root is the parent directory; branch detection fails without it).

## Phase 1: Quarantine hotfixes ⛔ GATED — separate explicit approval required

**Goal**: stop live data corruption; change nothing else.
**Independent test**: post a purchase invoice on staging → `branch_inventory_balances` increases; malformed confirm payload cannot produce an unbalanced entry.

- [ ] T001 [P1-hotfix] [US1] Route purchase-invoice confirm inventory writes through InventoryEngine.apply (replace direct `tx.inventoryMovement.create` loop) in apps/api/src/modules/purchase-invoices/purchase-invoices.controller.ts
- [ ] T002 [P1-hotfix] [US1] Add Σdebit==Σcredit assertion (Decimal) before journal creation in purchase-invoice confirm in apps/api/src/modules/purchase-invoices/purchase-invoices.controller.ts
- [ ] T003 [P1-hotfix] Integration test: purchase confirm updates balance + rejects unbalanced payload in apps/api/src/modules/purchase-invoices/purchase-invoices.hotfix.spec.ts
- [ ] T004 [P1-hotfix] [P] Mark legacy ledger UIs read-only with migration-notice banner (payments page, factory-orders mutations) in apps/web/app/[locale]/(app)/factory-orders/page.tsx and apps/web/app/[locale]/(app)/purchasing/supplier-payments/page.tsx

## Phase 2: Foundation — engine, periods, configuration

**Goal**: PostingEngine + config skeleton exist and are invariant-tested; nothing user-facing changes yet.
**Independent test**: engine unit suite green (balanced-only, period lock, immutability, idempotency, party-required, sequence numbering).

- [ ] T010 Expand migration: company_profile, financial_periods, posting_profiles, tax_profiles, expense_categories, numbering_series, print_templates, costing_settings, warehouses tables per data-model.md in apps/api/prisma/migrations/<ts>_redesign_foundation/migration.sql
- [ ] T011 Expand migration: journal_entries +status/period_id/reversal_of_id/source_type/source_id; journal_lines +party_type/party_id/branch_id + XOR CHECK + balanced-entry deferred trigger; accounts +is_cash_or_bank/treasury_type/system_role in apps/api/prisma/migrations/<ts>_redesign_journal_dimensions/migration.sql
- [ ] T012 Update Prisma schema to match T010–T011 in apps/api/prisma/schema.prisma
- [ ] T013 [P] Zod schemas for all new entities + posting request/response in packages/shared/src/schemas/api/posting.ts, configuration.ts, treasury.ts
- [ ] T014 [US1] PostingEngine service — post(): balanced/atomic/period-checked/sequence-numbered/idempotent, party-required on control accounts, audit in-tx per technical-spec-en.md §PostingEngine in apps/api/src/modules/posting/posting.engine.ts
- [ ] T015 [US2] Reversal service — reverse(entryId, reason) creating linked mirrored entry in apps/api/src/modules/posting/reversal.service.ts
- [ ] T016 [US1] Engine invariant unit tests (all 7 invariants + concurrency/sequence collision) in apps/api/src/modules/posting/posting.engine.spec.ts
- [ ] T017 [P] [US2] Periods module: CRUD + close (checklist) + reopen (OWNER, reason) + guards per contracts in apps/api/src/modules/periods/periods.controller.ts
- [ ] T018 [P] [US4] Configuration module: company profile, posting-profile versions, tax-profile versions, expense categories, numbering series, print templates, costing guarded change per contracts/endpoints.md in apps/api/src/modules/configuration/
- [ ] T019 [P] [US4] Effective-date resolver (config-as-of-posting-date) + unit tests in apps/api/src/modules/configuration/effective-config.service.ts + .spec.ts
- [ ] T020 Central permission map (Action→Roles) replacing ad-hoc @Roles lists; generated matrix endpoint GET /settings/permissions in apps/api/src/common/permissions.ts
- [ ] T021 ESLint rule: forbid journalEntry.create / journalLine.create outside apps/api/src/modules/posting/ in .eslintrc.cjs (custom no-restricted-syntax entries)
- [ ] T022 [P] CI property test: random valid posting sequences keep trial balance balanced in apps/api/test/property/trial-balance.property.spec.ts
- [ ] T023 Seed refactor: split shared seed (COA template EG-trading, default categories/numbering/print) from Elshrouq tenant seed pack in apps/api/prisma/seed.ts + apps/api/prisma/tenant-seeds/elshrouq.ts
- [ ] T024 [P] Integration tests for configuration write endpoints: permission gating, version creation, deactivation guards (warehouse_has_stock, account_is_system, currency_locked) in apps/api/src/modules/configuration/configuration.spec.ts

## Phase 3: Documents — rebuild posting flows

**Goal**: invoices, returns, expenses post mandatorily through the engine with auto accounts + costing; US1 halfway (no vouchers yet).
**Independent test**: golden-path suites assert exact Dr/Cr rows, stock deltas, avg-cost updates; zero account pickers in confirm UIs.

- [ ] T030 [US1] Purchase-invoice posting flow per FR-010 (engine entry, InventoryEngine RECEIPT, WAC update under row lock, tax/rate snapshot, numbering) in apps/api/src/modules/purchase-invoices/purchase-invoices.controller.ts + posting service
- [ ] T031 [US1] Golden-path test purchase posting (Dr/Cr exact, stock, avg_cost math) in apps/api/src/modules/purchase-invoices/purchase-posting.spec.ts
- [ ] T032 [US1] Sales-invoice posting flow per FR-011 (stock validation hard-block, revenue+VAT entry, auto-COGS entry from avg_cost, unit_cost_at_posting stamp) in apps/api/src/modules/sales-invoices/sales-invoices.controller.ts + posting service
- [ ] T033 [US1] Golden-path test sales posting incl. insufficient-stock rejection and COGS math in apps/api/src/modules/sales-invoices/sales-posting.spec.ts
- [ ] T034 [P] [US1] Expenses mandatory posting via category mapping + treasury/on-credit source per FR-013 in apps/api/src/modules/expenses/expenses.controller.ts
- [ ] T035 [P] [US1] Golden-path test expense posting in apps/api/src/modules/expenses/expense-posting.spec.ts
- [ ] T036 [US2] Remove DELETE /journal/:id and all posted-document delete paths; wire reverse endpoints for invoices/expenses per contracts in apps/api/src/modules/journal/journal.controller.ts + document controllers
- [ ] T037 [US2] Reversal round-trip tests (stock + GL restored; reversal_would_negate_stock case) in apps/api/src/modules/posting/reversal.spec.ts
- [ ] T038 [P] [US1] Returns module (sales/purchase) mirroring invoices per FR-014 in apps/api/src/modules/returns/ + golden-path tests in returns-posting.spec.ts
- [ ] T039 [P] Migration: customer_orders.customer_name → customer_id FK with name-mapping backfill in apps/api/prisma/migrations/<ts>_orders_customer_fk/migration.sql
- [ ] T040 [US1] Posting-preview endpoint (shared resolution path, no writes) per contracts in apps/api/src/modules/posting/preview.controller.ts
- [ ] T041 Remove Arabic literals from API business logic → error codes + params; move strings to i18n catalogs (A11) in apps/api/src/modules/** (sweep task, lint-verified)
- [ ] T042 [US1] Invoice-level discount per FR-015: capture on both invoice types, Dr Discount line via posting profile, golden-path assertion in apps/api/src/modules/*-invoices/ + discount-posting.spec.ts
- [ ] T043 [US4] Effective-date acceptance test: post → change tax rate/posting profile → reprint old (unchanged) + post new (new values); includes opening-balance re-import-requires-reversal case in apps/api/test/config-effective-date.spec.ts
- [ ] T044 [US2] Route manual journal entries (POST /journal) through PostingEngine with MANUAL source_type; remove direct create path in apps/api/src/modules/journal/journal.controller.ts

## Phase 4: Treasury, vouchers & data migration

**Goal**: money in/out via vouchers; legacy ledgers migrated and retired; US1 complete end-to-end.
**Independent test**: voucher golden paths + zero-diff reconciliation on client snapshot. **⚠ blocked on client answers ق١–ق٤ (client-questions.md).**

- [ ] T050 [US1] Treasury accounts: banks/vaults as GL accounts (is_cash_or_bank) + settings endpoints in apps/api/src/modules/configuration/treasury-accounts.controller.ts
- [ ] T051 [US1] Receipt/payment voucher documents + FIFO-default editable allocations + open-items endpoint per FR-012/contracts in apps/api/src/modules/treasury/
- [ ] T052 [US1] Golden-path tests both vouchers incl. over-allocation rejection and على-الحساب remainder in apps/api/src/modules/treasury/voucher-posting.spec.ts
- [ ] T053 Migration pipeline: CustomerTransaction/FactoryLedgerEntry/Payment/collections → opening balances + GL history per client decision ق٤, two-phase dry-run→commit in apps/api/src/modules/import/legacy-migration.service.ts
- [ ] T054 Reconciliation report (old stored balances vs derived GL per party/account; zero-diff gate) in apps/api/src/modules/import/reconciliation.service.ts + spec
- [ ] T055 Contract migration: drop customer_transactions, factory_ledger_entries, payments, payment_accounts after sign-off in apps/api/prisma/migrations/<ts>_retire_parallel_ledgers/migration.sql
- [ ] T056 [P] [US3] Opening-balance wizard endpoints (dry-run/commit, balanced OPENING set, trial-balance gate) in apps/api/src/modules/configuration/opening-balances.controller.ts

## Phase 5: Reports on unified GL

**Goal**: every report reads posted journal lines/movements only (FR-030).
**Independent test**: trial balance balances and valuation reconciles on migrated production copy; each figure drills to journal entry.

- [ ] T060 [US1] Dynamic ledger endpoint (account/party/treasury filters, opening/running/closing, window function) per contracts in apps/api/src/modules/reports/ledger.controller.ts
- [ ] T061 [P] [US1] Party statements + AR/AP aging from open items minus allocations in apps/api/src/modules/reports/statements.controller.ts + aging.controller.ts (repoint)
- [ ] T062 [P] [US1] P&L, trial balance, balance-sheet repointed at GL with drill-down ids in apps/api/src/modules/reports/income-statement.controller.ts etc.
- [ ] T063 [P] [US1] VAT report (output−input per filing period, doc detail) in apps/api/src/modules/reports/vat.controller.ts
- [ ] T064 [P] [US1] Inventory balance + valuation-vs-GL reconciliation invariant + stock movement + cash/bank movement in apps/api/src/modules/reports/inventory.controller.ts, cash-bank.controller.ts
- [ ] T065 Report integration tests incl. SC-002 invariants on migrated snapshot in apps/api/test/reports/

## Phase 6: UX & settings module

**Goal**: new IA + design system + settings/wizard shipped; client walkthrough of US1 passes.
**Independent test**: Playwright full-cycle E2E (quickstart smoke script) green; UI matches ui-ux-spec.md states.

- [ ] T070 Design tokens → CSS variables (brandable per company) + IBM Plex Sans Arabic self-hosted per design-system.md in apps/web/tailwind.config.ts + apps/web/app/globals.css
- [ ] T071 [US1] Posting-preview component (G.20 anatomy) shared across all post actions in apps/web/components/features/posting/posting-preview.tsx
- [ ] T072 [US1] Rebuild sales & purchase invoice pages per ui-ux-spec G.4/G.5 (stock chips, margin preview, zero account pickers) in apps/web/app/[locale]/(app)/sales/invoices/ + purchasing/invoices/
- [ ] T073 [P] [US1] Voucher pages G.8/G.9 with allocation panel in apps/web/app/[locale]/(app)/treasury/
- [ ] T074 [P] [US1] Statements/report shells G.6–G.16 incl. drill-down in apps/web/app/[locale]/(app)/reports/
- [ ] T075 [US3] Settings module: 15 screens + shared (form|versions|change-log) pattern per G.16 in apps/web/app/[locale]/(app)/settings/
- [ ] T076 [US3] Setup wizard shell reusing settings screens + trial-balance gate in apps/web/app/[locale]/(app)/setup/
- [ ] T077 [P] Empty/error/confirmation states + reversal dialog with consequence text per G.17–G.19 across app pages
- [ ] T078 [P] Print templates (A4 invoice, A5 voucher, تفقيط amount-in-words) per design-system H.5 in apps/web/components/features/print/
- [ ] T079 Playwright E2E: full trading cycle + reversal + period-close block + AR/EN mirror per constitution gates in apps/web/e2e/trading-cycle.spec.ts
- [ ] T080 Remove hardcoded brand ("شروق · Shorok") and client literals from UI; source from CompanyProfile (SC-006 grep gate) in apps/web/app/[locale]/(app)/layout.tsx + sweep

## Phase 7: Productization

**Goal**: second tenant deployable in <1 day (SC-005).
**Independent test**: provision demo tenant from scratch using wizard + seed pack only.

- [ ] T090 [US3] UoM config on variants (uom_base/alt/conversion) replacing boards/meters hardcode; migrate size_meters_per_board in apps/api/prisma/migrations/<ts>_uom_config/migration.sql + affected services
- [ ] T091 [P] [US3] Tenant provisioning script (empty DB + migrations + shared seed + optional tenant pack) in scripts/provision-tenant.sh
- [ ] T092 [P] [US3] Move all Elshrouq catalog data into tenant seed pack; CI grep gate for client literals in apps/api/prisma/tenant-seeds/ + .github/workflows
- [ ] T093 [US3] Demo-tenant dry run + SC-005 checklist report in specs/elshrouq-erp-redesign/ (documentation task)

## Dependencies & execution order

- Phase 1 ⛔ independent hotfix (can run before/without later phases; requires its own approval)
- Phase 2 blocks 3; 3 blocks 4; 4 blocks 5 (reports need migrated data for gates); 6 depends on 3–5 APIs; 7 depends on 6
- Within phases, [P] tasks touch disjoint files and may run in parallel; posting tasks (T030/T032/T034/T038/T051) must precede their paired tests only in commit order — tests may be written first (TDD encouraged)
- Client answers ق١–ق٤ block T053–T056 execution, nothing else

## MVP scope note

US1 (trading cycle) = Phases 2–5 minimum. US3 wizard (T075–T076, Phase 7) can ship after client go-live without blocking it.

**Totals**: 62 tasks — Phase 1: 4 · Phase 2: 15 · Phase 3: 15 · Phase 4: 7 · Phase 5: 6 · Phase 6: 11 · Phase 7: 4 (includes analyze-remediation tasks T024, T042–T044). Parallelizable [P]: 23. Per-story: US1 28 · US2 5 · US3 8 · US4 3 · unlabeled infrastructure 18.
