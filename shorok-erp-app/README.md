# Shorok ERP

Production-grade ERP for Shorok — branch orders, inventory, expenses, factory ledger, dashboard. Arabic-first (RTL, `ar-EG`) with English (LTR) toggle.

## Getting started

See [`specs/main/quickstart.md`](specs/main/quickstart.md) for first-time setup. Short version:

```bash
cp .env.example .env
pnpm install
docker compose up -d postgres
pnpm --filter @shorok/api prisma migrate dev    # available after Phase 2
pnpm --filter @shorok/api seed                  # available after Phase 2
pnpm dev
```

## Spec & design artifacts

- [`specs/main/spec.md`](specs/main/spec.md) — feature specification (source of truth)
- [`specs/main/plan.md`](specs/main/plan.md) — implementation plan (stack, structure)
- [`specs/main/research.md`](specs/main/research.md) — Phase 0 decisions
- [`specs/main/data-model.md`](specs/main/data-model.md) — entities and integrity rules
- [`specs/main/contracts/openapi.yaml`](specs/main/contracts/openapi.yaml) — API contract
- [`specs/main/tasks.md`](specs/main/tasks.md) — task breakdown
- [`docs/ui-design/outputs/`](docs/ui-design/outputs) — feature design specs

## Constitution

The project's ratified principles live in [`.specify/memory/constitution.md`](.specify/memory/constitution.md).

## Workspace layout

```
apps/
  api/        NestJS 10 backend
  web/        Next.js 14 (App Router) frontend
packages/
  shared/     Zod schemas / enums / types shared between api + web
docs/
  ui-design/  Per-feature UI design specs
specs/main/   Spec, plan, contracts, tasks
```
