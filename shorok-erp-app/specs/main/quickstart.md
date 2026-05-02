# Quickstart: Shorok ERP MVP — local dev

This is a "from-zero" guide that mirrors what `/speckit-tasks` will codify into setup tasks. It is descriptive (decisions and steps) rather than imperative (do not run yet — the repo skeleton hasn't been generated).

## Prerequisites

- Node.js 20 LTS
- pnpm 9+
- Docker + Docker Compose
- A POSIX shell (the repo lives at a path with a space — `elshorok ERP/` — so always quote it)

## Topology

Three services run in Docker Compose:

```
postgres:16  ──── apps/api  (NestJS, port 3001)
                    │
                    └─── apps/web (Next.js, port 3000)
```

A shared `.env` file at the repo root supplies database URL, JWT secrets, and locale defaults to both apps.

## First-time setup (target flow)

```bash
# from repo root: shorok-erp-app/
cp .env.example .env
pnpm install
docker compose up -d postgres
pnpm --filter @shorok/api prisma migrate dev
pnpm --filter @shorok/api seed     # creates a demo OWNER and a demo branch
pnpm dev                            # turbo runs apps/web + apps/api in parallel
```

`pnpm dev` should leave you with:

- API at `http://localhost:3001/api/v1`
- Web at `http://localhost:3000` redirecting to `/ar` (default) or `/en`

## Demo data

`pnpm --filter @shorok/api seed` should produce:

- 1 OWNER user, phone `+201000000000`, password `Owner@2026`
- 1 demo branch
- 3 SKUs with 2 variants each (mirroring the legacy spreadsheet samples)
- 1 sample supplier
- A `system_settings` row with `default_price_override_tolerance_percent = 5.00`

Login flow to verify:

1. Open `http://localhost:3000`.
2. Land on `/ar/login`. Enter `+201000000000` and `Owner@2026`.
3. Land on `/ar/dashboard`. Switch language with the header toggle — URL becomes `/en/dashboard`, layout flips to LTR, text becomes English. No translation keys appear.

## Smoke checks (manual, before running E2E)

- **Inventory non-negative**: post a `RECEIPT` of `5` boards, then create a CONFIRMED order for `7` boards — should fail with HTTP 409 `insufficient_stock`.
- **Price tolerance**: with `default_price_override_tolerance_percent = 5.00`, create an order at `> 5%` deviation from the default — order status should be `PENDING_PRICE_APPROVAL`. Approve from an OWNER session, then confirm.
- **Audit log**: each of the above produces an `AuditLog` row with both AR and EN summaries, visible at `GET /audit?entityType=customer_order&entityId=…`.
- **RTL/LTR**: in `ar` the sidebar is on the right, table column order mirrors. In `en` everything flips. Date and currency formatting follows the locale (`Intl.NumberFormat`).

## Test harness

| Suite                 | Tool                | Where it runs                                |
|-----------------------|---------------------|----------------------------------------------|
| API unit              | Jest                | `pnpm --filter @shorok/api test`             |
| API integration       | Jest + real Postgres | `pnpm --filter @shorok/api test:int`         |
| Web component         | Jest + RTL          | `pnpm --filter @shorok/web test`             |
| End-to-end            | Playwright          | `pnpm --filter @shorok/web test:e2e`         |

The integration suite spins up a dedicated Postgres schema (`test_<id>`), runs migrations, and tears down after the run.

## Verifying the constitution

The `.specify/memory/constitution.md` file is still the placeholder template. Run `/speckit-constitution` and re-run `/speckit-plan` (or `/speckit-analyze`) so the gates evaluate against ratified principles. This quickstart already aligns with the de-facto principles documented in `plan.md` (data correctness, server-authoritative auth, audit-everything, i18n strictness, simplicity).
