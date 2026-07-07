# Quickstart — elshrouq-erp-redesign

**Status note**: implementation is NOT yet approved; this file orients future implementation sessions. Nothing here changes the current running system.

## Orientation (read in this order)
1. `spec.md` — what and why; FR/SC ids used everywhere else
2. `plan.md` — phase sequencing + constitution gates
3. `technical-spec-en.md` — ratified architecture decisions (A1–A11) and posting flows (normative Dr/Cr)
4. `data-model.md` + `contracts/endpoints.md` — schema and API deltas
5. `admin-configuration.md`, `ui-ux-spec.md`, `design-system.md`, `glossary-ar-en.md` — configuration, screens, tokens, terms
6. `tasks.md` — dependency-ordered work items (execute only with explicit approval)

## Dev bring-up (unchanged from specs/main/quickstart.md)
```bash
cd shorok-erp-app
docker compose up -d postgres     # Postgres 16 on :5432 (shorok/shorok/shorok_erp)
pnpm install
pnpm --filter @shorok/shared build
pnpm dev                          # web :3000 + api :3001 via turbo
```
Migrations are hand-written SQL under `apps/api/prisma/migrations/` — never `prisma migrate dev`. Apply with `prisma migrate deploy` against the dev DB.

## Rules that bind every implementation session
- Constitution v2.0.0 gates all work — especially VI (only PostingEngine writes journals; only InventoryEngine moves stock), VII (no edit/delete of posted records), VIII (no client literals in code).
- Arabic UI strings come from message catalogs using `glossary-ar-en.md` terms; API returns error codes, not Arabic text.
- Every posting flow lands with its golden-path test (exact Dr/Cr rows + stock delta + avg-cost effect) before the endpoint is wired to UI.
- Phase exit gates run against a copy of the client's real data (see plan.md table).
- The two P0 hotfixes (purchase stock bypass, unbalanced-entry guard) are tasks T-P1-01/02 in tasks.md and are the ONLY items allowed to touch production code ahead of Phase 2 — and only after Ahmed's explicit approval.

## Smoke script (post-Phase-5 definition of done)
Login → post purchase invoice (stock ↑, AP ↑, VAT-in ↑, avg cost updates) → post sales invoice (blocked on shortage; else stock ↓, AR ↑, revenue+VAT-out, COGS auto) → receipt voucher allocated FIFO → payment voucher → expense → P&L, statements, VAT report, trial balance all reflect it; reverse the sales invoice and watch everything roll back via the linked reversal.
