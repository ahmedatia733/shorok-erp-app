# Implementation Plan: Shorok ERP MVP

**Branch**: `main` | **Date**: 2026-05-02 | **Spec**: [./spec.md](./spec.md)
**Input**: Feature specification from `/specs/main/spec.md`

## Summary

Replace the branch and factory Excel sheets with a production-grade smart ERP that manages orders, inventory (no negative stock), expenses, factory purchases per supplier, collections, branch balances, and operational reporting — Arabic-first (RTL) with English (LTR) toggle, multi-branch, RBAC, full audit trail, and a one-shot Excel migration path from the legacy sheets.

Technical approach: TypeScript end-to-end monorepo (pnpm workspaces + Turborepo) with a Next.js App Router frontend, a NestJS backend, PostgreSQL via Prisma. Inventory and order writes go through a transactional engine with row-level locks and a DB-level non-negative check; pricing outside the per-variant tolerance routes through an Owner/Admin approval state. Auth is phone-first (Egypt E.164 format) with password + JWT access/refresh tokens; RBAC is enforced server-side via NestJS guards. i18n uses `next-intl` on the web and `nestjs-i18n` on the API; UI uses Tailwind logical properties so RTL/LTR mirror cleanly. Excel import (`exceljs`) is a synchronous service for the MVP migration. Tests: Jest (unit + API) and Playwright (E2E). Local dev and MVP deployment via Docker Compose.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 20 LTS
**Primary Dependencies**:
- Web: Next.js 14+ (App Router), React 18, Tailwind CSS 3.4+, shadcn/ui, next-intl, TanStack Query, react-hook-form
- API: NestJS 10+, Prisma 5+, Passport (JWT strategy), bcrypt, nestjs-i18n, libphonenumber-js, exceljs, Zod (via nestjs-zod), Pino
- Shared: Zod (schemas + types shared across apps)

**Storage**: PostgreSQL 16; money columns as `NUMERIC(14,2)` (Prisma `Decimal`); branch on-hand stock guarded by a `CHECK (boards_on_hand >= 0 AND meters_on_hand >= 0)` constraint.

**Testing**: Jest (unit + integration on apps/api with a real PostgreSQL test schema), Jest + React Testing Library on apps/web, Playwright for cross-cutting E2E flows.

**Target Platform**: Server-rendered web app served behind a reverse proxy in Docker; modern desktop and tablet browsers (Chrome, Edge, Safari, Firefox) — Egyptian Arabic primary locale.

**Project Type**: Web application (frontend + backend in a monorepo). Structure: `apps/web`, `apps/api`, `packages/shared`.

**Performance Goals**: Order creation and inventory writes p95 < 300 ms server-side under typical branch load; dashboard loads p95 < 1.5 s on a normal connection.

**Constraints**:
- Inventory must never go negative — enforced at the application layer (transactional row lock + balance check) AND at the database layer (CHECK constraint).
- All money calculations deterministic (decimal arithmetic, never floats).
- No hardcoded UI strings — all text via translation keys (`ar-EG`, `en`); translation keys must never reach the user.
- All actions logged (append-only audit trail) inside the same transaction as the action.
- Backend authoritative for authorization; frontend restrictions are UX only.

**Scale/Scope (MVP target)**: 2–5 branches, 5–30 users, ≤ 10k SKUs / variants combined, ≤ 50k orders/year, ≤ 200k inventory movements/year. Comfortably fits a single Postgres instance.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The repository's `.specify/memory/constitution.md` is still the placeholder template — no project principles have been ratified yet. As a result, no enforced gates are in effect. This is **flagged as a gate concern**, not a violation: the plan proceeds, and the principles below are de-facto operating rules, copied from `spec.md` and the user's plan inputs. Run `/speckit-constitution` to formalize them and re-evaluate gates.

**De-facto principles enforced by this plan:**

1. **Data correctness over speed** — financial and stock writes go through Postgres transactions; CHECK constraints back the application logic; deletes of confirmed financial/stock records are forbidden (use cancellation/reversal entries).
2. **Authorization is server-side** — every protected endpoint passes through `JwtAuthGuard` + `RolesGuard` + branch-scope enforcement; the frontend trusts no client-side claim.
3. **Audit-everything** — every state-changing handler writes an `AuditLog` row in the same transaction; logs are append-only (no UPDATE/DELETE on `audit_logs`).
4. **i18n strictness** — Lint rule + code review forbid string literals in user-visible JSX/responses; messages live in `apps/web/messages/{ar,en}.json` and `apps/api/i18n/{ar,en}/`.
5. **Simplicity** — no microservices, no event bus, no read replicas in MVP; single API service, single Postgres, Docker Compose deployment.

**Initial gate result**: **PASS (with placeholder constitution)** — proceeding to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/main/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (OpenAPI + endpoint summaries)
│   ├── openapi.yaml
│   └── endpoints.md
└── tasks.md             # Phase 2 output (created by /speckit-tasks)
```

### Source Code (repository root: `shorok-erp-app/`)

```text
apps/
├── web/                          # Next.js 14 App Router
│   ├── app/
│   │   └── [locale]/
│   │       ├── (auth)/login/page.tsx
│   │       └── (app)/
│   │           ├── layout.tsx           # sidebar shell, locale-aware
│   │           ├── dashboard/page.tsx
│   │           ├── orders/
│   │           ├── inventory/
│   │           ├── expenses/
│   │           ├── suppliers/
│   │           ├── factory-orders/
│   │           ├── reports/
│   │           ├── audit/
│   │           └── settings/
│   ├── components/
│   │   ├── ui/                          # shadcn/ui generated primitives
│   │   └── features/                    # feature components
│   ├── lib/
│   │   ├── api-client.ts                # typed fetch wrapper
│   │   ├── auth.ts
│   │   └── format.ts                    # currency/date/number per locale
│   ├── messages/
│   │   ├── ar.json
│   │   └── en.json
│   ├── i18n.ts                          # next-intl config
│   ├── middleware.ts                    # locale + auth redirects
│   ├── tailwind.config.ts
│   └── tests/
│       └── e2e/                         # Playwright specs
│
└── api/                          # NestJS 10
    ├── src/
    │   ├── modules/
    │   │   ├── auth/                    # login, refresh, logout, JWT strategy
    │   │   ├── users/                   # CRUD users, roles, allowed_branches
    │   │   ├── branches/
    │   │   ├── products/                # SKU + Variant
    │   │   ├── inventory/               # balances, movements, count
    │   │   │   └── inventory.engine.ts  # transactional engine (no-negative)
    │   │   ├── orders/                  # customer orders + collections + price-override approvals
    │   │   ├── expenses/
    │   │   ├── suppliers/
    │   │   ├── factory-orders/          # supplier ledger
    │   │   ├── reports/                 # dashboard aggregations
    │   │   ├── audit/                   # AuditService (called by other modules)
    │   │   └── import/                  # Excel migration endpoints
    │   ├── common/
    │   │   ├── guards/                  # JwtAuthGuard, RolesGuard, BranchScopeGuard
    │   │   ├── interceptors/            # logging, error mapping
    │   │   ├── decorators/              # @CurrentUser(), @Roles(), @Branch()
    │   │   └── pipes/                   # ZodValidationPipe
    │   ├── config/                      # env validation (Zod), config module
    │   ├── prisma/                      # PrismaService wrapper
    │   ├── i18n/
    │   │   ├── ar/
    │   │   └── en/
    │   └── main.ts
    ├── prisma/
    │   ├── schema.prisma
    │   ├── migrations/
    │   └── seed.ts                      # seeds roles, demo branch, demo admin
    └── tests/
        ├── unit/
        ├── integration/                 # hits a real Postgres test DB
        └── fixtures/

packages/
└── shared/
    ├── src/
    │   ├── schemas/                     # Zod schemas (single source of truth)
    │   ├── types/                       # inferred TS types
    │   ├── enums/                       # Role, OrderStatus, MovementType, etc.
    │   └── constants/                   # currency code, locale codes, defaults
    └── package.json

docs/
└── ui-design/
    └── outputs/
        ├── 00-design-system/design.md
        ├── auth/design.md
        ├── dashboard/design.md
        ├── orders/design.md
        ├── inventory/design.md
        ├── expenses/design.md
        ├── suppliers/design.md
        ├── factory-orders/design.md
        ├── reports/design.md
        ├── audit/design.md
        └── settings/design.md

docker-compose.yml                 # postgres + api + web
docker-compose.override.yml        # dev overrides
package.json                       # workspace root
pnpm-workspace.yaml
turbo.json
.env.example
README.md
```

**Structure Decision**: Web application monorepo (`apps/web` + `apps/api` + `packages/shared`) using **pnpm workspaces** + **Turborepo**. This matches the user's explicit request, gives us a single typed contract layer (`packages/shared` Zod schemas) consumed by both apps, and keeps the deployment surface simple (two Docker images + Postgres).

UI design specs (`docs/ui-design/outputs/<feature>/design.md`) are a hard prerequisite for any UI implementation per the user's plan inputs and are listed under Phase 1 deliverables for the design system entry; per-feature design specs are produced as part of the per-feature task batch in `/speckit-tasks`.

## Complexity Tracking

> Filled only when Constitution Check has violations that must be justified.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| (none — initial gate passed with placeholder constitution; revisit after `/speckit-constitution`) | — | — |
