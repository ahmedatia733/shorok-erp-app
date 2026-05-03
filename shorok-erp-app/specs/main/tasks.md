# Tasks: Shorok ERP MVP

**Input**: Design documents from `/specs/main/`
**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/ ✓
**Constitution**: `.specify/memory/constitution.md` v1.0.0 (ratified 2026-05-02)

**Tests**: Tests are explicitly listed in `plan.md` (Jest unit + integration on the API, Jest + RTL on the web, Playwright E2E). Critical-correctness areas (inventory non-negative invariant, order status machine, factory running balance, RBAC + branch scoping, audit-log atomicity) carry mandatory test tasks. Tests for the rest are recommended but not enumerated as separate tasks.

**Organization**: Tasks are grouped by user story to enable independent implementation, demo, and rollout of each module.

## Format: `[ID] [P?] [Story] Description`

- **[P]** = parallelizable (different files, no upstream dependency on incomplete tasks)
- **[Story]** = user-story label (US1…US8) for traceability
- All paths are relative to repo root `shorok-erp-app/`
- Backend tasks always precede frontend tasks for the same story (per project rule)
- UI tasks always have a `design.md` prerequisite (per project rule); if a feature lacks a design spec, the first task of that story creates it

---

## Path Conventions

- Backend: `apps/api/src/modules/<module>/`, `apps/api/prisma/`, `apps/api/src/i18n/{ar,en}/`
- Frontend: `apps/web/app/[locale]/{(auth),(app)}/<feature>/`, `apps/web/components/`, `apps/web/messages/{ar,en}.json`
- Shared: `packages/shared/src/{schemas,types,enums,constants}/`
- Design specs: `docs/ui-design/outputs/<feature>/design.md`
- Tests: `apps/api/tests/{unit,integration}/`, `apps/web/tests/e2e/`

---

## User-Story Map (priority order)

| ID  | Title                       | Priority | Why this priority                                         |
|-----|-----------------------------|----------|------------------------------------------------------------|
| US1 | Inventory module            | P1       | Inventory must exist BEFORE orders (project rule); all stock writes go through one engine that backs the no-negative invariant. |
| US2 | Customer Orders + Collections | P2     | Headline business flow; depends on US1's `InventoryEngine` for SALE drawdown and on the Products catalog from Foundational. |
| US3 | Expenses                    | P3       | Branch-scoped, independent; small surface. |
| US4 | Suppliers + Factory Ledger  | P4       | Supplier CRUD MUST come BEFORE factory ledger entries (project rule); both are bundled in this story. |
| US5 | Dashboard & Reports         | P5       | Aggregates all prior modules; can only be demoed once US1–US4 produce data. |
| US6 | Audit Log Viewer            | P6       | The audit *write path* is in Foundational (cross-cutting); only the read UI is here. |
| US7 | Excel Import (one-shot migration) | P7 | Depends on every domain module being writable; one-shot per business need. |
| US8 | Admin & Settings UI         | P8       | UI for Branches/Users/Products/Suppliers/SystemSettings — APIs are in Foundational and seedable, so this UI can ship last without blocking demos. |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the monorepo skeleton, dev tooling, and Docker Compose target.

- [ ] T001 Initialize pnpm workspace at repo root (`shorok-erp-app/package.json`, `pnpm-workspace.yaml`, `turbo.json`); add `apps/*` and `packages/*` to workspaces.
- [ ] T002 [P] Create `.env.example` at repo root with `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `DEFAULT_LOCALE=ar`, `WEB_PORT=3000`, `API_PORT=3001`.
- [ ] T003 [P] Add root `tsconfig.base.json` (strict, `target: ES2022`, `module: ESNext`, path aliases for `@shorok/shared`).
- [ ] T004 [P] Configure root ESLint (`@typescript-eslint`) and Prettier in `.eslintrc.cjs`, `.prettierrc.json` at repo root.
- [ ] T005 [P] Add Husky + lint-staged (`.husky/pre-commit` runs `pnpm lint-staged`).
- [ ] T006 [P] Create `docker-compose.yml` (services: `postgres:16`, `api`, `web`) and `docker-compose.override.yml` (dev volumes/hot-reload) per `quickstart.md` topology.
- [ ] T007 [P] Scaffold `packages/shared` (`packages/shared/package.json`, `tsconfig.json`, `src/index.ts`).
- [ ] T008 [P] Scaffold `apps/api` (NestJS 10 CLI: `nest new --package-manager=pnpm`); add `nestjs-zod`, `nestjs-i18n`, `nestjs-pino`, `prisma`, `@prisma/client`, `bcrypt`, `passport`, `passport-jwt`, `libphonenumber-js`, `exceljs`, `decimal.js`.
- [ ] T009 [P] Scaffold `apps/web` (`create-next-app@latest --app --ts --tailwind`); add `next-intl`, `@tanstack/react-query`, `react-hook-form`, `@hookform/resolvers`, `zod`; init shadcn/ui (`pnpx shadcn@latest init`).
- [ ] T010 Add root `README.md` pointing to `quickstart.md` and `specs/main/plan.md`.

**Checkpoint**: `pnpm install` succeeds at root; `pnpm dev` runs both apps as empty stubs; `docker compose up postgres` starts cleanly.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Database schema + migrations FIRST, then all cross-cutting wiring (auth, guards, audit service, i18n, web layout, admin-catalog APIs, login UI). **No user story may begin until this phase is complete.**

### 2A. Shared package — schemas, enums, types

- [ ] T011 [P] `packages/shared/src/enums/`: define `Role`, `UserStatus`, `ProductCategory`, `MovementType`, `OrderStatus`, `PriceOverrideStatus`, `AuditAction` per `data-model.md`.
- [ ] T012 [P] `packages/shared/src/schemas/`: Zod schemas for every entity in `data-model.md` (Branch, User, RefreshToken, ProductSku, ProductVariant, Supplier, BranchInventoryBalance, InventoryMovement, CustomerOrder, OrderCollection, Expense, FactoryLedgerEntry, AuditLog, SystemSettings).
- [ ] T013 [P] `packages/shared/src/schemas/api/`: Zod request/response DTOs matching `contracts/openapi.yaml` (auth, users, branches, products, inventory, orders, expenses, suppliers, factory-ledger, reports, audit, import).
- [ ] T014 [P] `packages/shared/src/types/`: re-export `z.infer<>` types for everything in T012/T013.
- [ ] T015 [P] `packages/shared/src/constants/errors.ts`: stable error codes (`insufficient_stock`, `price_approval_required`, `invalid_state_transition`, `invalid_credentials`, `token_expired`, `user_disabled`, `missing_references`, `invalid_workbook`, etc.).
- [ ] T016 [P] `packages/shared/src/constants/locales.ts`: `LOCALES = ['ar','en'] as const`, `DEFAULT_LOCALE = 'ar'`, `CURRENCY = 'EGP'`.

### 2B. Database schema and migrations (FIRST per project rule)

- [ ] T017 `apps/api/prisma/schema.prisma`: define **every** model from `data-model.md` (Branch, User, UserBranchAccess, RefreshToken, ProductSku, ProductVariant, Supplier, BranchInventoryBalance, InventoryMovement, CustomerOrder, OrderCollection, Expense, FactoryLedgerEntry, AuditLog, SystemSettings, IdempotencyKey).
- [ ] T018 `apps/api/prisma/schema.prisma`: declare all enums (Role, UserStatus, ProductCategory, MovementType, OrderStatus, PriceOverrideStatus, AuditAction).
- [ ] T019 `apps/api/prisma/migrations/<ts>_initial/migration.sql`: generate the initial migration, then **append raw SQL** for `CHECK (boards_on_hand >= 0 AND meters_on_hand >= 0)` on `branch_inventory_balances`, plus the `system_settings` single-row CHECK (`id = 1`).
- [ ] T020 `apps/api/prisma/migrations/<ts>_append_only_grants/migration.sql`: SQL migration that creates `shorok_app` DB role and `REVOKE UPDATE, DELETE ON audit_logs, inventory_movements, order_collections, factory_ledger_entries FROM shorok_app;` (per Constitution Principle III + `data-model.md` cross-cutting rule 2).
- [ ] T021 `apps/api/prisma/seed.ts`: per `quickstart.md` — seed 1 OWNER (`+201000000000` / `Owner@2026`), 1 demo branch, 3 SKUs × 2 variants, 1 supplier, the `system_settings` row (`default_price_override_tolerance_percent = 5.00`, `low_stock_threshold_boards = 5`).
- [ ] T022 [P] `apps/api/tests/integration/setup.ts`: integration-test harness (creates `test_<id>` schema, runs migrations, returns Prisma client, tears down after each suite).

### 2C. API cross-cutting (NestJS bootstrap, auth, guards, audit, i18n)

- [ ] T023 `apps/api/src/main.ts` + `apps/api/src/app.module.ts`: bootstrap NestJS; register `nestjs-pino` (JSON in prod, `pino-pretty` in dev); global `RequestIdMiddleware` (`x-request-id`); global error filter that maps `InsufficientStockError`, `InvalidStateTransitionError`, `PriceApprovalRequiredError`, validation errors → the `{ code, message_ar, message_en, details? }` shape from `contracts/endpoints.md` §Cross-cutting.
- [ ] T024 `apps/api/src/config/`: env config with Zod validation (loads `.env`; fails fast on missing/invalid).
- [ ] T025 `apps/api/src/prisma/prisma.service.ts`: PrismaService wrapper exposing `$transaction` and a `runInTransaction(fn)` helper used by every command handler.
- [ ] T026 `apps/api/src/common/pipes/zod-validation.pipe.ts`: `nestjs-zod`-based validation pipe consuming shared schemas from `@shorok/shared`.
- [ ] T027 `apps/api/src/i18n/`: configure `nestjs-i18n` with `ar`/`en` namespaces (`common`, `errors`, `audit`); resolver order = explicit `?locale=` → `Accept-Language` → default `ar`.
- [ ] T028 [P] `apps/api/src/i18n/ar/errors.json`, `apps/api/src/i18n/en/errors.json`: AR + EN translations for every error code from T015.
- [ ] T029 `apps/api/src/modules/auth/auth.module.ts`: phone-based login (`libphonenumber-js` EG normalize → E.164), bcrypt password verify, JWT access (15 min) + opaque refresh (7d, sha256-hashed in `refresh_tokens`); endpoints `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`; refresh delivered as `httpOnly Secure SameSite=Lax` cookie per research R5.
- [ ] T030 `apps/api/src/common/guards/jwt-auth.guard.ts`: verifies access token, loads user, attaches to request.
- [ ] T031 `apps/api/src/common/guards/roles.guard.ts` + `apps/api/src/common/decorators/roles.decorator.ts`: `@Roles(OWNER, BRANCH_MANAGER, …)` enforcement.
- [ ] T032 `apps/api/src/common/guards/branch-scope.guard.ts` + `apps/api/src/common/decorators/branch.decorator.ts`: matches request `branchId` against `UserBranchAccess`; OWNER bypass.
- [ ] T033 `apps/api/src/modules/audit/audit.service.ts`: `AuditService.write({ tx, actor, action, entityType, entityId, before, after, summaryAr, summaryEn })` MUST be called inside the same `prisma.$transaction` as the action (Constitution Principle III). Provide localized-summary builders pattern; export so every other module imports it.
- [ ] T033b `apps/api/src/modules/audit/audit-read.controller.ts`: `GET /audit?entityType=&entityId=` (cursor-paged) and `GET /audit/by-actor/:userId` (OWNER only); BRANCH_MANAGER scoped via `BranchScopeGuard` on the resolved entity's branch. Lives in Foundational so every later story (order detail, supplier detail, etc.) can render an audit tail; the dedicated viewer page is US6.
- [ ] T034 `apps/api/src/common/middleware/idempotency.middleware.ts`: optional `Idempotency-Key` header → store `(key, response_hash, body)` for 24h in `idempotency_keys` table; replay on duplicate.
- [ ] T035 [P] `apps/api/tests/integration/auth.spec.ts`: login (valid + invalid + disabled), refresh (rotation), `/me`, RBAC denial (403), branch-scope denial (403), JWT expiry (401).
- [ ] T036 [P] `apps/api/tests/integration/audit-atomicity.spec.ts`: forces an `AuditService.write` failure inside a transaction and asserts the action is rolled back (Constitution Principle III).

### 2D. Foundational admin APIs (catalog needed by every story)

- [ ] T037 [P] `apps/api/src/modules/branches/`: GET/POST/PATCH `/branches`, POST `/branches/:id/deactivate` — OWNER only writes; AuditService calls per mutation.
- [ ] T038 [P] `apps/api/src/modules/users/`: GET/POST/PATCH `/users`, `POST /users/:id/{disable,enable,password-reset}` — OWNER only; bcrypt password set; manages `UserBranchAccess`.
- [ ] T039 [P] `apps/api/src/modules/products/sku.controller.ts`: GET/POST/PATCH `/products/skus`.
- [ ] T040 [P] `apps/api/src/modules/products/variant.controller.ts`: GET/POST/PATCH `/products/variants?skuId=`.
- [ ] T041 [P] `apps/api/src/modules/suppliers/`: GET/POST/PATCH `/suppliers` (OWNER, ACCOUNTANT can read+create; OWNER patches). **This task is the "supplier ledger BEFORE factory orders" gate** — US4 (factory ledger) cannot start until this lands.
- [ ] T042 [P] `apps/api/src/modules/system-settings/`: GET/PATCH `/system-settings` (OWNER only); enforces single-row.
- [ ] T043 [P] `apps/api/tests/integration/admin-catalog.spec.ts`: branches/users/products/suppliers/system-settings happy paths + RBAC denials.

### 2E. Web cross-cutting (locale routing, layout, i18n lint, design system)

- [ ] T044 `apps/web/i18n.ts` + `apps/web/middleware.ts`: `next-intl` config with locale segments `/ar` (default) and `/en`; middleware handles locale negotiation + auth redirect; sets `<html lang dir>` from locale segment.
- [ ] T045 `apps/web/app/[locale]/layout.tsx`: root layout, `<html lang dir>`, `<NextIntlClientProvider>`, font setup (Egyptian Arabic + Latin), TanStack Query provider.
- [ ] T046 `apps/web/tailwind.config.ts`: enable Tailwind v3.4+ logical properties; brand colors from `docs/ui-design/outputs/00-design-system/design.md`.
- [ ] T047 `apps/web/.eslintrc.cjs`: ESLint rule banning `ml-/mr-/pl-/pr-/left-/right-` in JSX `className` (per Constitution Principle IV); ESLint rule banning string literals in JSX text and component text-prop attributes outside of `t()` / `<Trans>` (per Constitution Principle IV).
- [ ] T048 [P] `apps/web/messages/ar.json`, `apps/web/messages/en.json`: baseline namespaces (`common`, `validation`, `errors`, `auth`, `nav`); copy is real Arabic / real English text — never the key name.
- [ ] T049 [P] `apps/web/lib/format.ts`: locale-aware currency / date / number formatters (`Intl.NumberFormat(locale, { style: 'currency', currency: 'EGP' })`, `Intl.DateTimeFormat`).
- [ ] T050 `apps/web/lib/api-client.ts`: typed fetch wrapper using `@shorok/shared` schemas; injects `Authorization` from auth context; auto-refresh on 401; surfaces server-localized `{ message_ar, message_en }`.
- [ ] T051 `apps/web/lib/auth.ts`: client auth context (access token in memory, refresh via cookie), `useCurrentUser`, `useHasRole(role)`, `useBranchAccess(branchId)`.
- [ ] T052 `apps/web/components/ui/`: generate shadcn/ui primitives required by `docs/ui-design/outputs/00-design-system/design.md` (button, input, label, form, select, dialog, dropdown-menu, table, toast, sonner, sheet, tabs, badge, card, separator).
- [ ] T053 `apps/web/components/layout/app-shell.tsx`: app layout with collapsible sidebar (mirrors per `dir`), header with language switcher + branch picker + user menu, per design system.
- [ ] T054 `apps/web/components/layout/language-switcher.tsx`: toggles `/ar` ↔ `/en`, preserves path + query.
- [ ] T054b `apps/web/components/features/audit/audit-tail.tsx`: reusable inline timeline component backed by the T033b `GET /audit?entityType=&entityId=` endpoint — renders `human_readable_summary_<locale>`, paginates, used by order detail (T089), supplier detail, factory ledger detail, and the dedicated audit page (T119).

### 2F. Auth UI (login is a precondition for any story demo)

- [ ] T055 [P] `docs/ui-design/outputs/auth/design.md` (NEW DESIGN SPEC): screens for login + token-expired re-auth dialog; Arabic-first, RTL; phone input with country code (default `+20`); inline validation copy AR + EN. Required by project rule "No UI implementation without design spec".
- [ ] T056 `apps/web/app/[locale]/(auth)/login/page.tsx`: login screen per T055; `react-hook-form` + Zod from `@shorok/shared`; submits via `lib/api-client`; redirects to `/[locale]/dashboard`.
- [ ] T057 `apps/web/app/[locale]/(app)/layout.tsx`: protected app layout that requires an authenticated user; renders `app-shell`.

### 2G. Foundational i18n + RTL validation gate

- [ ] T058 `apps/api/tests/integration/i18n.spec.ts`: every error code returns both `message_ar` and `message_en` populated (no fallback to English when `?locale=ar`).
- [ ] T059 `apps/web/tests/e2e/auth-rtl.spec.ts` (Playwright): login in `/ar` (sidebar on right, RTL mirroring), switch to `/en` (LTR), no translation keys appear in the DOM (`expect(page.locator('body')).not.toContainText(/^[a-z]+(\.[a-z]+)+$/)`).

**Checkpoint**: API boots; migrations run with non-negative + append-only constraints; OWNER can log in; `<html dir>` flips with locale; both locales render real text; RBAC + branch-scope guards block unauthorized requests; AuditService is wired and atomic. **User-story phases unblocked.**

---

## Phase 3: User Story 1 — Inventory Module (P1) MVP-CORE

**Goal**: Warehouse + branch users can post receipts, adjustments, and counts; balances and movements are visible per branch; the system **never** allows a balance to go negative.

**Independent Test**: From a seeded branch with zero stock, post a `RECEIPT` of 5 boards for variant V → `GET /inventory/balances` shows 5; attempt an `ADJUSTMENT` of `-7` → HTTP 409 `insufficient_stock`; the audit log shows the receipt, not the rejected adjustment.

### Backend (US1)

- [ ] T060 [US1] `apps/api/src/modules/inventory/inventory.engine.ts`: implement `InventoryEngine.apply({ branchId, variantId, movementType, boardsDelta, reference, actor, summaryAr, summaryEn })` per research R7 — runs inside `prisma.$transaction`: `SELECT … FOR UPDATE` the balance row, compute new `boards_on_hand` + `meters_on_hand` (using `variant.size_meters_per_board`), throw `InsufficientStockError` if negative, UPDATE balance, INSERT `InventoryMovement`, call `AuditService.write` in the same tx.
- [ ] T061 [P] [US1] `apps/api/tests/integration/inventory-engine.spec.ts`: non-negative invariant under (a) sequential receipt → over-sale, (b) two parallel sales racing the same balance, (c) DB CHECK rejects bypass attempt.
- [ ] T062 [US1] `apps/api/src/modules/inventory/balances.controller.ts`: `GET /inventory/balances?branchId=` (paged); flags low-stock per `system_settings.low_stock_threshold_boards`.
- [ ] T063 [US1] `apps/api/src/modules/inventory/movements.controller.ts`: `GET /inventory/movements?branchId=&variantId?&type?&from?&to?` (paged ledger).
- [ ] T064 [US1] `apps/api/src/modules/inventory/receipts.controller.ts`: `POST /inventory/receipts` (OWNER, BRANCH_MANAGER, WAREHOUSE) → `InventoryEngine.apply({ movementType: RECEIPT, boardsDelta: +N })`.
- [ ] T065 [US1] `apps/api/src/modules/inventory/adjustments.controller.ts`: `POST /inventory/adjustments` → `ADJUSTMENT` with signed delta.
- [ ] T066 [US1] `apps/api/src/modules/inventory/counts.controller.ts`: `POST /inventory/counts` → for each line, compute `delta = countedBoards − currentOnHand` and post a `COUNT_CORRECTION` via `InventoryEngine.apply` (one tx for the batch).
- [ ] T067 [P] [US1] `apps/api/src/i18n/ar/inventory.json`, `apps/api/src/i18n/en/inventory.json`: error messages (`insufficient_stock`, `invalid_movement`) and audit summary templates.
- [ ] T068 [P] [US1] `apps/api/tests/integration/inventory-endpoints.spec.ts`: receipts/adjustments/counts happy + denial paths; verifies movement ledger order; verifies audit row written same-tx.

### Frontend (US1) — design.md exists ✓

- [ ] T069 [US1] `apps/web/app/[locale]/(app)/inventory/page.tsx`: balances list per `docs/ui-design/outputs/inventory/design.md`; branch picker; low-stock badge.
- [ ] T070 [US1] `apps/web/app/[locale]/(app)/inventory/receipts/new/page.tsx`: receipt form (variant search, boards quantity, note); on submit calls `POST /inventory/receipts`.
- [ ] T071 [US1] `apps/web/app/[locale]/(app)/inventory/adjustments/new/page.tsx`: adjustment form (signed delta + required note).
- [ ] T072 [US1] `apps/web/app/[locale]/(app)/inventory/counts/new/page.tsx`: count screen — table of variants with current `onHand` and editable `countedBoards`; live variance preview; one submit posts the whole batch.
- [ ] T073 [US1] `apps/web/app/[locale]/(app)/inventory/movements/page.tsx`: paged movements ledger with filters (variant, type, date range); LTR-aligned numeric columns even in `ar`.
- [ ] T074 [P] [US1] `apps/web/messages/ar.json` + `messages/en.json`: append `inventory` namespace (real AR + EN copy for every label, button, error, validation).
- [ ] T075 [P] [US1] `apps/web/tests/e2e/inventory.spec.ts` (Playwright): seed → receipt → balance update; over-adjust rejected with localized error; count flow updates balances and writes movements.

**Checkpoint**: User Story 1 fully working — non-negative invariant proven at API + DB + UI; movements + audit visible; AR/EN both render real text.

---

## Phase 4: User Story 2 — Customer Orders & Collections (P2)

**Goal**: Branch users can create orders, route over-tolerance prices through OWNER approval, confirm orders (drawing inventory through `InventoryEngine`), record collections, and cancel with reversal entries.

**Independent Test**: Seed inventory at 10 boards for variant V. Create order for 7 boards at +10% deviation → status `PENDING_PRICE_APPROVAL`. OWNER approves → status flips. Confirm order → balance drops to 3, SALE movement recorded, audit row created. Record collection equal to `required_amount` → status `PAID`. Cancel order (OWNER) → reversal SALE movement returns balance to 10; refund `OrderCollection` row appended.

### Backend (US2)

- [ ] T076 [US2] `apps/api/src/modules/orders/order-status-machine.ts`: implement allowed-transition matrix from `data-model.md` §State machine; `assertTransition(from, to)` throws `InvalidStateTransitionError`.
- [ ] T077 [P] [US2] `apps/api/tests/unit/order-status-machine.spec.ts`: every allowed transition + every blocked transition.
- [ ] T078 [US2] `apps/api/src/modules/orders/orders.service.ts`: `createOrder` — computes `metersQuantity`, `requiredAmount`, `remainingAmount` with `decimal.js`; computes price deviation against `variant.default_sale_price_per_meter` and `variant.price_override_tolerance_percent ?? system_settings.default…`; sets `priceOverrideStatus` and initial `status` (`DRAFT` vs `PENDING_PRICE_APPROVAL`).
- [ ] T079 [US2] `apps/api/src/modules/orders/orders.controller.ts`: `POST /orders` and `PATCH /orders/:id` (DRAFT only); RBAC OWNER + BRANCH_MANAGER; branch-scoped.
- [ ] T080 [US2] `apps/api/src/modules/orders/price-approval.controller.ts`: `POST /orders/:id/price-approval` — OWNER only; flips `priceOverrideStatus → APPROVED`, sets `priceApprovedByUserId`, `priceApprovedAt`; AuditAction `APPROVE`.
- [ ] T081 [US2] `apps/api/src/modules/orders/confirm.controller.ts`: `POST /orders/:id/confirm` — inside one tx: assert state machine → `DRAFT/PENDING_PRICE_APPROVAL → CONFIRMED`; reject HTTP 409 `price_approval_required` if status was `PENDING_PRICE_APPROVAL` and `priceOverrideStatus !== APPROVED`; call `InventoryEngine.apply({ movementType: SALE, boardsDelta: -boardsQuantity, reference: { type: 'customer_order', id } })` (this both enforces no-negative and writes the audit).
- [ ] T082 [US2] `apps/api/src/modules/orders/cancel.controller.ts`: `POST /orders/:id/cancel` — OWNER any state; BRANCH_MANAGER `CONFIRMED` only (per `endpoints.md`); for `CONFIRMED|PARTIALLY_COLLECTED|PAID` post a reversal SALE movement (positive boards delta) and append a refund `OrderCollection` row matching collected_amount; transition to `CANCELLED`; AuditAction `CANCEL`.
- [ ] T083 [US2] `apps/api/src/modules/orders/collections.controller.ts`: `POST /orders/:id/collections` — OWNER + BRANCH_MANAGER + ACCOUNTANT; CHECK at insert: new `collected_amount` may not exceed `required_amount` for non-cancelled orders (HTTP 409); refunds (`amount < 0`) only via cancel flow; updates order `status` (`CONFIRMED → PARTIALLY_COLLECTED → PAID`).
- [ ] T084 [US2] `apps/api/src/modules/orders/orders-list.controller.ts`: `GET /orders?branchId=&status=` and `GET /orders/:id`; cursor pagination per `endpoints.md`.
- [ ] T085 [P] [US2] `apps/api/src/i18n/{ar,en}/orders.json`: error codes (`insufficient_stock`, `price_approval_required`, `invalid_state_transition`, `collection_exceeds_required`) + audit summary templates (e.g., AR: "تم تأكيد طلب رقم {id} للعميل {customer} بمبلغ {amount} ج.م"; EN: "Order {id} confirmed for {customer} at {amount} EGP").
- [ ] T086 [P] [US2] `apps/api/tests/integration/orders.spec.ts`: covers — within-tolerance happy path, over-tolerance approval flow, insufficient_stock blocks confirmation, partial + full collection, cancellation reverses inventory and collections, RBAC + branch-scope denials.

### Frontend (US2) — design.md exists ✓

- [ ] T087 [US2] `apps/web/app/[locale]/(app)/orders/page.tsx`: orders list per `docs/ui-design/outputs/orders/design.md`; status filter; status pills with localized text.
- [ ] T088 [US2] `apps/web/app/[locale]/(app)/orders/new/page.tsx`: order form — variant search, boards qty, sale price/meter (live deviation indicator + tolerance bar from `variant.price_override_tolerance_percent ?? default`), receiver, optional initial collection.
- [ ] T089 [US2] `apps/web/app/[locale]/(app)/orders/[id]/page.tsx`: order detail — fields, status, primary actions (Confirm / Approve price / Cancel) gated by `useHasRole`; AuditLog tail showing localized summaries.
- [ ] T090 [US2] `apps/web/components/features/orders/collection-drawer.tsx`: drawer for recording collections; warns when entered amount would exceed remaining.
- [ ] T091 [P] [US2] `apps/web/messages/{ar,en}.json`: append `orders` namespace.
- [ ] T092 [P] [US2] `apps/web/tests/e2e/orders.spec.ts` (Playwright): create order at 8% over default with `tolerance = 5%` → `PENDING_PRICE_APPROVAL`; OWNER approves, BRANCH_MANAGER confirms; insufficient stock variant fails confirm with localized message; collect 50% → `PARTIALLY_COLLECTED`; collect rest → `PAID`.

**Checkpoint**: User Story 2 fully working — order lifecycle + price approval + collections + cancellation reversals; inventory and audit entries are correct end-to-end.

---

## Phase 5: User Story 3 — Expenses (P3)

**Goal**: Authorized users record branch-scoped expenses; OWNER may post negative-amount adjustments; expenses appear in dashboard aggregations.

**Independent Test**: Branch user posts an expense → it appears in `GET /expenses?branchId=` for that branch only; another branch's user cannot see it; audit log row exists.

### Backend (US3)

- [ ] T093 [US3] `apps/api/src/modules/expenses/expenses.controller.ts`: `POST /expenses` (OWNER, BRANCH_MANAGER, ACCOUNTANT; branch-scoped) and `GET /expenses?branchId=&from?&to?` (any authed user for that branch). OWNER may post `amount < 0` (correction); others enforce `amount > 0`.
- [ ] T094 [P] [US3] `apps/api/src/i18n/{ar,en}/expenses.json`: validation + audit summaries.
- [ ] T095 [P] [US3] `apps/api/tests/integration/expenses.spec.ts`: branch-scope isolation, RBAC, negative-amount restriction, audit row written.

### Frontend (US3) — design.md exists ✓

- [ ] T096 [US3] `apps/web/app/[locale]/(app)/expenses/page.tsx`: expenses list per `docs/ui-design/outputs/expenses/design.md`; date-range filter; branch picker.
- [ ] T097 [US3] `apps/web/app/[locale]/(app)/expenses/new/page.tsx`: expense form (date, description, amount, paid_from_account).
- [ ] T098 [P] [US3] `apps/web/messages/{ar,en}.json`: append `expenses` namespace.

**Checkpoint**: User Story 3 fully working.

---

## Phase 6: User Story 4 — Suppliers + Factory Ledger (P4)

**Goal**: Accountants/owners maintain suppliers and post factory purchase rows + payment-only rows; running balance per supplier is computed transactionally.

**⚠️ Project rule "Supplier ledger BEFORE factory orders"**: Suppliers CRUD API is in Foundational (T041) and is a hard prerequisite for this story; within this story, Suppliers design spec (T105) and Suppliers UI (T106) precede the Factory Ledger UI (T107–T108).

**Independent Test**: Create supplier S → post a purchase entry of 1000 EGP and a payment of 600 EGP → `running_balance` for S = 400; back-date a row earlier than existing entries → recompute kicks in and balances stay correct.

### Backend (US4)

- [ ] T099 [US4] `apps/api/src/modules/factory-ledger/recompute.sql.ts`: SQL function (or guarded raw query) that recomputes `running_balance` for a supplier ordered by `(order_date, created_at)` whenever a back-dated row is inserted; runs inside the same tx (per `data-model.md` line 268).
- [ ] T100 [US4] `apps/api/src/modules/factory-ledger/entries.controller.ts`: `POST /factory-ledger/entries` (purchase rows: `supplierId`, optional `productVariantId`, `boardsQuantity`, `purchasePricePerMeter` → derives `metersQuantity` and `totalAmount`; `paidAmount ≥ 0`).
- [ ] T101 [US4] `apps/api/src/modules/factory-ledger/payments.controller.ts`: `POST /factory-ledger/payments` (payment-only: `supplierId`, `paidAmount`, `notes?`; `productVariantId/boardsQuantity = null`).
- [ ] T102 [US4] `apps/api/src/modules/factory-ledger/list.controller.ts`: `GET /factory-ledger?supplierId=` returns chronological rows including `running_balance`.
- [ ] T103 [P] [US4] `apps/api/src/i18n/{ar,en}/factory-ledger.json`: errors + audit summaries.
- [ ] T104 [P] [US4] `apps/api/tests/integration/factory-ledger.spec.ts`: running balance per supplier across mixed purchase/payment rows; back-dated insertion triggers correct recompute; balances differ across suppliers.

### Frontend (US4)

- [ ] T105 [US4] `docs/ui-design/outputs/suppliers/design.md` (NEW DESIGN SPEC): suppliers list, create/edit dialog, archive action; AR-first RTL; consistent with design system. Required by project rule "No UI implementation without design spec".
- [ ] T106 [US4] `apps/web/app/[locale]/(app)/suppliers/page.tsx`: suppliers list per T105.
- [ ] T107 [US4] `apps/web/app/[locale]/(app)/factory-orders/page.tsx`: factory ledger view per `docs/ui-design/outputs/factory-orders/design.md`; supplier picker; running-balance footer per supplier.
- [ ] T108 [US4] `apps/web/app/[locale]/(app)/factory-orders/new/page.tsx`: tabbed form (Purchase row / Payment-only) submitting to the right endpoint.
- [ ] T109 [P] [US4] `apps/web/messages/{ar,en}.json`: append `suppliers` and `factory_orders` namespaces.

**Checkpoint**: User Story 4 fully working — supplier list usable, factory ledger reads/writes correctly per supplier.

---

## Phase 7: User Story 5 — Dashboard & Reports (P5)

**Goal**: Aggregated view of sales, collections, remaining, stock summary, expenses, factory balances per supplier, and low-stock alerts. OWNER can omit `branchId` for an all-branches view.

**Independent Test**: With seeded data + a confirmed order + an expense + a factory entry, `GET /reports/dashboard?branchId=…` returns the aggregated numbers; the dashboard page renders all six widgets in AR and EN with correctly formatted EGP currency.

### Backend (US5)

- [ ] T110 [US5] `apps/api/src/modules/reports/dashboard.service.ts`: aggregator that runs branch-scoped queries (or all-branches for OWNER) — total sales (= sum of `CONFIRMED|PAID|PARTIALLY_COLLECTED` `requiredAmount`), collected (sum of `OrderCollection.amount`), remaining, stock value/quantity summary, expenses sum, factory balances per supplier, low-stock list (variants below threshold).
- [ ] T111 [US5] `apps/api/src/modules/reports/dashboard.controller.ts`: `GET /reports/dashboard?branchId=`.
- [ ] T112 [P] [US5] `apps/api/tests/integration/dashboard.spec.ts`: branch-scoped vs all-branches; cancellations excluded; refunds reduce collected; per-supplier balances correct.

### Frontend (US5)

- [ ] T113 [US5] `docs/ui-design/outputs/reports/design.md` (NEW DESIGN SPEC): reports page (canned exports list — placeholder per research R-Open "concrete report list pending feedback"). Required by project rule.
- [ ] T114 [US5] `apps/web/app/[locale]/(app)/dashboard/page.tsx`: dashboard per `docs/ui-design/outputs/dashboard/design.md` — KPI cards (sales, collected, remaining), stock summary, expenses, supplier balances, low-stock list; `Intl.NumberFormat(locale, { style: 'currency', currency: 'EGP' })`.
- [ ] T115 [US5] `apps/web/app/[locale]/(app)/reports/page.tsx`: reports stub per T113.
- [ ] T116 [P] [US5] `apps/web/messages/{ar,en}.json`: append `dashboard` and `reports` namespaces.

**Checkpoint**: User Story 5 fully working.

---

## Phase 8: User Story 6 — Audit Log Viewer (P6)

**Goal**: OWNER (and BRANCH_MANAGER for their branch's records) can browse the append-only audit trail with localized human-readable summaries from a dedicated viewer page (the read endpoints already exist from Foundational T033b and have been used by every prior story's detail view).

**Independent Test**: After running US1–US4 flows, the dedicated audit page shows a timeline of every action with both `human_readable_summary_ar` and `human_readable_summary_en` populated; switching `/ar` ↔ `/en` swaps the displayed text. No row is editable.

### Backend (US6) — extends the read endpoints from T033b

- [ ] T117 [P] [US6] `apps/api/tests/integration/audit-read.spec.ts`: pagination on T033b endpoints, branch-scope filtering for BRANCH_MANAGER, OWNER sees all, by-actor view for OWNER, no UPDATE/DELETE accepted (DB GRANT enforces — overlap with T139 is intentional).

### Frontend (US6)

- [ ] T118 [US6] `docs/ui-design/outputs/audit/design.md` (NEW DESIGN SPEC): dedicated audit log timeline view, filters by entity type/id and actor, per-row expand to show before/after JSON. Required by project rule. (The reusable inline `audit-tail` component already exists from Foundational T054b.)
- [ ] T119 [US6] `apps/web/app/[locale]/(app)/audit/page.tsx`: dedicated audit viewer per T118 — wraps T054b with filters (entityType, entityId, actor, date range); LTR-aligned timestamps and JSON blobs even in AR.
- [ ] T120 [P] [US6] `apps/web/messages/{ar,en}.json`: append `audit` namespace.

**Checkpoint**: User Story 6 fully working.

---

## Phase 9: User Story 7 — Excel Import (one-shot migration) (P7)

**Goal**: OWNER uploads a legacy `.xlsx` workbook, sees a dry-run report, fixes references, then commits — the commit either applies the whole workbook in a single transaction or rolls back.

**Independent Test**: Upload a sample inventory sheet → dry-run reports `rowsValid`, `validationErrors`, `missingReferences`; resolve the references; commit → balances and movements appear; re-uploading the same workbook produces a clean dry-run with no duplicate writes (idempotency-key on commit).

### Backend (US7)

- [ ] T122 [US7] `apps/api/src/modules/import/excel.parser.ts`: `exceljs` streaming parsers per kind — `orders` (`الاوردرات`), `inventory` (`الجرد*`/`الوارد*`), `expenses` (`المصروفات`/`مصروفات*`), `factory_ledger` (`طلبيات المصنع`).
- [ ] T123 [US7] `apps/api/src/modules/import/import.service.ts`: dry-run produces `{ sessionId, rowsParsed, rowsValid, validationErrors[], missingReferences{ skuCodes[], variantSizes[] } }`; commits run all writes inside one `prisma.$transaction` (orders go through full flow including `InventoryEngine` for SALE; inventory goes through `RECEIPT`; factory ledger inserts with running-balance recompute).
- [ ] T124 [US7] `apps/api/src/modules/import/import.controller.ts`: `POST /import/dry-run` (multipart `file` + `kind` + `branchId?` + `supplierId?`), `POST /import/commit` (same body or `{ importSessionId }`), `GET /import/sessions/:id` — all OWNER only.
- [ ] T125 [US7] `apps/api/src/modules/import/preflight.ts`: per research R15 — require nominated supplier for factory sheets; require nominated branch for branch-ambiguous sheets; require all referenced product codes resolved; commit returns 409 `missing_references` otherwise.
- [ ] T126 [P] [US7] `apps/api/src/i18n/{ar,en}/import.json`: validation error codes (`invalid_workbook`, `missing_references`, etc.) + per-row error templates.
- [ ] T127 [P] [US7] `apps/api/tests/integration/import.spec.ts`: dry-run on each kind with sample fixtures; all-or-nothing commit (induced row failure rolls everything back); idempotency-key prevents double-commit.

### Frontend (US7)

- [ ] T127b [US7] `docs/ui-design/outputs/settings/design.md` (NEW DESIGN SPEC): the full Settings area — sub-nav (Users · Branches · Products · Suppliers · System Settings · **Import**), per-section list/detail patterns, and the Import wizard flow (pick kind → upload → dry-run report → resolve references → commit); AR-first RTL; consistent with design system. Created here in US7 because import is the first consumer; US8 reuses it. Required by project rule "No UI implementation without design spec".
- [ ] T128 [US7] `apps/web/app/[locale]/(app)/settings/import/page.tsx`: import wizard per T127b — pick kind → upload → dry-run report (parsed/valid/errors/missing references) → resolve references → commit.

**Checkpoint**: User Story 7 fully working — one-shot migration path validated against sample legacy sheets.

---

## Phase 10: User Story 8 — Admin & Settings UI (P8)

**Goal**: OWNER manages users, branches, products, suppliers, system settings, and accesses Excel import — all from a unified Settings area. APIs already exist (Foundational); this story is UI only.

**Independent Test**: OWNER navigates Settings → creates a branch, adds a user with branch access, creates a SKU + variants, creates a supplier, edits the price-override tolerance default, and runs an import. Each action shows AR/EN copy and produces an audit log entry.

Settings design spec (`docs/ui-design/outputs/settings/design.md`) was created in US7 as T127b. US8 builds on it directly.

- [ ] T129 [US8] `apps/web/app/[locale]/(app)/settings/layout.tsx`: settings shell with sub-navigation per T127b.
- [ ] T130 [US8] `apps/web/app/[locale]/(app)/settings/users/page.tsx`: users list + create/edit dialog (phone E.164 input default `+20`, role, allowed_branches multi-select, password set/reset).
- [ ] T131 [US8] `apps/web/app/[locale]/(app)/settings/branches/page.tsx`: branches list + create/edit/deactivate.
- [ ] T132 [US8] `apps/web/app/[locale]/(app)/settings/products/page.tsx`: SKU list + variants nested editor (size, default sale/purchase prices, tolerance %).
- [ ] T133 [US8] `apps/web/app/[locale]/(app)/settings/suppliers/page.tsx`: thin re-use of T106 components inside settings shell, or link out to `/suppliers`.
- [ ] T134 [US8] `apps/web/app/[locale]/(app)/settings/system/page.tsx`: system settings form (`default_price_override_tolerance_percent`, `low_stock_threshold_boards`).
- [ ] T135 [P] [US8] `apps/web/messages/{ar,en}.json`: append `settings` namespace (real AR + EN copy).

**Checkpoint**: All user stories shipped.

---

## Phase 11: Polish & Cross-Cutting Concerns

- [ ] T137 [P] `apps/web/tests/e2e/i18n-rtl-validation.spec.ts` (Playwright): full app sweep — every page in `/ar` shows real Arabic (no key strings, no English bleed-through), every page in `/en` shows real English; sidebar mirrors per locale; numeric/currency/date formatting matches `Intl` for the active locale.
- [ ] T138 [P] `apps/api/tests/integration/audit-everywhere.spec.ts`: every state-changing endpoint produces an `AuditLog` row with both AR and EN summaries (drives a parameterized list of `(method, path, body)` cases).
- [ ] T139 [P] `apps/api/tests/integration/append-only.spec.ts`: connect as the `shorok_app` DB role and assert UPDATE/DELETE on `audit_logs`, `inventory_movements`, `order_collections`, `factory_ledger_entries` are denied.
- [ ] T140 [P] `apps/api/tests/integration/non-negative-cross-module.spec.ts`: combined orders + adjustments + counts cannot drive any balance negative.
- [ ] T141 [P] `apps/web/tests/e2e/rbac-visibility.spec.ts`: per role, sidebar entries and action buttons match the role's permitted endpoints.
- [ ] T142 [P] `apps/web/tests/lint/forbidden-utilities.spec.ts`: ESLint rule from T047 actually fails on a sample `ml-2` / `pl-4` / hardcoded English literal.
- [ ] T143 [P] `apps/api/perf/order-create.bench.ts`: order creation + confirmation p95 < 300 ms (per `plan.md` perf goal).
- [ ] T144 Run `quickstart.md` end-to-end on a clean machine and capture any drift back into the doc.
- [ ] T145 Production hardening checklist (off-MVP, captured for handoff): reverse proxy + TLS termination, Postgres `pg_dump` cron, log retention policy.
- [ ] T146 [P] Update root `README.md` with deployment + post-MVP follow-ups.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 Setup** → no dependencies
- **Phase 2 Foundational** → depends on Phase 1; **blocks every user story**
  - T017–T021 (DB schema + migrations + seed) MUST land before any user-story API task that touches the DB
  - T029–T033b (auth + guards + AuditService write + audit-read controllers) MUST land before any user-story endpoint or detail-view UI
  - T044–T054b (web shell + i18n + design system + reusable `audit-tail`) MUST land before any user-story UI task
  - T055–T057 (auth UI) MUST land before any other UI can be exercised manually
  - T041 (Suppliers API) gates US4 ("supplier ledger BEFORE factory orders")
- **Phase 3 US1** → depends on Foundational; produces `InventoryEngine` (blocks US2's confirm/cancel)
- **Phase 4 US2** → depends on US1's `InventoryEngine` + Foundational Products
- **Phase 5 US3** → depends only on Foundational
- **Phase 6 US4** → depends on Foundational T041 (Suppliers API)
- **Phase 7 US5** → depends on US1–US4 producing data (for the dashboard to be meaningful)
- **Phase 8 US6** → depends on Foundational AuditService (write path) + US1–US5 producing audit rows for demo
- **Phase 9 US7** → depends on US1–US4 (uses their write paths) + Foundational catalog APIs
- **Phase 10 US8** → depends on Foundational catalog APIs (T037–T042); pure UI
- **Phase 11 Polish** → depends on every user story shipped

### Within each user story

- All backend tasks before all frontend tasks (project rule: "Backend BEFORE frontend", "API BEFORE UI")
- Within backend: types/SQL fns → service → controllers → tests (or tests in parallel with [P] when independent)
- Within frontend: design.md (if missing) → page → form → translations → E2E test
- Translations and E2E tests are parallelizable with the corresponding page tasks ([P])

### Parallel opportunities

- Setup tasks T002–T009: nearly all `[P]` — can run together
- Foundational T011–T016 (shared package), T028 (i18n JSON), T037–T042 (admin catalog APIs): mostly `[P]`
- Foundational T035–T036 (auth + audit-atomicity tests): `[P]`
- Within each user story, `[P]` tasks (translations, tests, isolated controllers) can run together
- Different user stories CAN run in parallel after Foundational, EXCEPT US2 needs US1's `InventoryEngine` and US7 wants every domain module live

---

## Parallel Example: Foundational Phase

```bash
# After T001 monorepo init, run together:
Task T002: ".env.example"
Task T003: "tsconfig.base.json"
Task T004: "ESLint + Prettier root"
Task T005: "Husky + lint-staged"
Task T006: "docker-compose.yml"
Task T007: "scaffold packages/shared"
Task T008: "scaffold apps/api"
Task T009: "scaffold apps/web"
```

```bash
# After T017–T021 schema/migrations land, run shared package + admin APIs together:
Task T011: "shared enums"
Task T012: "shared entity Zod schemas"
Task T013: "shared API DTO Zod schemas"
Task T037: "Branches module"
Task T038: "Users module"
Task T039: "Products SKU module"
Task T040: "Products Variant module"
Task T041: "Suppliers module"
Task T042: "SystemSettings module"
```

---

## Implementation Strategy

### MVP path (recommended)

1. Phase 1 Setup
2. Phase 2 Foundational (heavy — most of the cross-cutting work lives here)
3. Phase 3 US1 Inventory → STOP, validate non-negative invariant end-to-end
4. Phase 4 US2 Orders → STOP, demo the headline flow (this is the "MVP demo" milestone)
5. Phase 5 US3 Expenses, Phase 6 US4 Factory Ledger → STOP, demo financial views
6. Phase 7 US5 Dashboard → first real visual proof of value
7. Phase 8 US6 Audit Viewer
8. Phase 9 US7 Excel Import → run the one-shot migration with operators
9. Phase 10 US8 Admin & Settings UI
10. Phase 11 Polish

### Incremental delivery

Each user story is independently testable and demoable behind feature-flag-style nav gating. Earliest releasable cut: Foundational + US1 + US2.

### Parallel team strategy (if staffed)

After Foundational lands:

- Dev A: US1 → US2 (sequential because of `InventoryEngine` dependency)
- Dev B: US3 → US4 (independent of A)
- Dev C: US5 → US6 (waits for A+B for meaningful data; can scaffold UI in parallel)
- Dev D: US7 → US8 (waits on every domain module; can scaffold settings UI early)

---

## Notes

- `[P]` tasks operate on different files with no upstream incomplete deps — safe to parallelize
- `[Story]` label is `US1`–`US8`; Setup, Foundational, Polish are unlabeled
- Every UI task explicitly cites its `design.md` source; missing design specs (auth, suppliers, reports, audit, settings) are created as the FIRST task of the relevant story per project rule
- Every state-changing API task implicitly carries an AuditService write inside the same transaction (Constitution Principle III)
- Every user-facing string is added to `messages/{ar,en}.json` AND `apps/api/src/i18n/{ar,en}/` — never hardcoded (Constitution Principle IV)
- Confirmed financial/stock records are NEVER hard-deleted — corrections are compensating entries (Constitution Principle I + spec §Data Integrity)
- Verify each checkpoint locally (smoke checks in `quickstart.md`) before moving to the next phase
- Commit after each task or logical group; the `after_tasks` hook in `.specify/extensions.yml` will offer to auto-commit `tasks.md` itself
