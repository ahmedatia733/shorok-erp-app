# Research: Shorok ERP MVP — Phase 0

This document resolves the open technology and pattern questions raised by `plan.md` and `spec.md`. Each entry follows: **Decision → Rationale → Alternatives considered**.

---

## R1. Monorepo tooling

**Decision**: pnpm workspaces + Turborepo.

**Rationale**: Native workspace support handles `apps/web`, `apps/api`, `packages/shared` cleanly. Turborepo gives task caching (`build`, `lint`, `test`) without forcing a build-system rewrite. Both are widely used with Next.js + NestJS combinations.

**Alternatives considered**:
- npm workspaces — works, but slower installs and worse dedup with NestJS deep dependency trees.
- Yarn Berry / Plug'n'Play — extra integration friction with Prisma and shadcn/ui generators.
- Nx — more capable but heavier; the user's "simple architecture" priority argues against it.

---

## R2. Frontend framework + i18n library

**Decision**: Next.js 14 App Router with `next-intl`. Locale segment in URL: `/ar/...` and `/en/...` (default `ar`).

**Rationale**: `next-intl` is the de-facto i18n choice for App Router; it integrates with server components, has a typed messages API, and handles ICU MessageFormat for plurals/numbers/currency/dates per locale. Locale-as-route-segment makes language switching, sharing, and SEO trivial and matches the "users can switch language at any time" requirement.

**Alternatives considered**:
- `react-i18next` — works, but App Router server-component support is awkward; double the boilerplate.
- Custom context provider — reinvents the wheel; would forfeit ICU formatting.

---

## R3. RTL/LTR strategy

**Decision**: Set `<html dir>` from the locale segment (`ar` → `rtl`, `en` → `ltr`). Use **Tailwind logical properties** (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`, `text-start`, `text-end`) for all directional spacing/alignment. No `tailwindcss-rtl` plugin.

**Rationale**: Tailwind v3.3+ ships logical properties natively; combined with `dir="rtl"` on the root element this makes layouts mirror automatically — sidebars flip, table column order flips, scrollbars flip. Adding a plugin is unnecessary complexity. shadcn/ui components are built with logical properties already.

**Alternatives considered**:
- `tailwindcss-rtl` plugin — extra dep; was needed before logical-property utilities shipped natively.
- Two parallel stylesheets — maintenance disaster, rejected immediately.

**Key rules captured for implementation**:
- All component code must use logical properties (lint rule TBD in tasks: forbid `ml-/mr-/pl-/pr-/left-/right-` in `apps/web`).
- Icons that imply direction (chevrons, arrows) must mirror via `[dir=rtl]:rotate-180` or use direction-neutral icons.
- Numeric tables stay LTR-aligned for digits; column order mirrors with `dir`.

---

## R4. Backend framework + i18n

**Decision**: NestJS 10 with `nestjs-i18n` for error messages and any user-facing copy returned by the API (e.g., audit-log human-readable summaries). Translation files at `apps/api/src/i18n/{ar,en}/*.json`.

**Rationale**: Keeps API responses localizable per `Accept-Language` (or an explicit `?locale=` query); audit-log summaries can be generated server-side in both languages and stored alongside the structured log per the spec.

**Alternatives considered**:
- Returning only translation keys and letting the frontend resolve — fails for audit logs, which must be stored as human-readable strings in both languages per spec.

---

## R5. Auth strategy

**Decision**:
- Login identifier: phone in **E.164** format, validated/normalized by `libphonenumber-js` with default country `EG`. Stored as a single `phone` column with a unique index.
- Password: `bcrypt` with cost factor 12. No password complexity rule beyond a minimum length of 8 (MVP).
- Tokens: **JWT access token (15 min)** + **opaque refresh token (7 days, rotated on every refresh)**. Refresh tokens hashed (`sha256`) and stored in a `refresh_tokens` table; the raw token is delivered to the client as a `httpOnly`, `Secure`, `SameSite=Lax` cookie. Access token is stored in memory and sent in `Authorization: Bearer …`.
- RBAC: roles `OWNER`, `BRANCH_MANAGER`, `WAREHOUSE`, `ACCOUNTANT`, `VIEWER` from `spec.md`. Implemented via `@Roles(...)` decorator + `RolesGuard`. Branch scoping via `BranchScopeGuard` that reads the user's `allowed_branches` and matches the request's `branchId` parameter.
- Logout: client clears access token; server revokes refresh token (delete row).

**Rationale**: Phone-first matches the resolved clarification. Short access token + rotating refresh token is the modern standard; cookie-housed refresh + bearer access keeps XSS damage scoped to the access token's lifetime. RBAC + branch-scope as guards centralizes policy and is straightforward to test.

**Alternatives considered**:
- Sessions with server-side store — more state, more code; rejected for MVP simplicity.
- OAuth/Auth0 — overkill for an internal tool with a known user roster; adds external dependency.
- SMS OTP login — out of scope per "Password-based (MVP)".

---

## R6. Money handling

**Decision**: PostgreSQL `NUMERIC(14,2)` for all currency columns. Prisma `Decimal` type. Currency code constant `EGP`. All arithmetic in the API uses `Decimal.js` (which Prisma's Decimal extends) — never `number`. Frontend formats with `Intl.NumberFormat(locale, { style: "currency", currency: "EGP" })`.

**Rationale**: Floats break in financial code; `NUMERIC` + Decimal is the orthodox answer and is explicitly required by the spec ("All money calculations must be deterministic and auditable").

**Alternatives considered**: Storing piasters as `BIGINT` (×100) — works, but requires application-side division for every display and breaks Prisma typings; not worth the cognitive overhead at this scale.

---

## R7. Inventory transaction engine (no-negative invariant)

**Decision**: A single application service, `InventoryEngine`, owns every write that changes a `BranchInventoryBalance` row. The engine is the only path through which `InventoryMovement` rows are created. Each operation runs inside `prisma.$transaction(...)`:

1. `SELECT … FROM branch_inventory_balances WHERE branch_id = ? AND product_variant_id = ? FOR UPDATE` (row-level lock).
2. Compute the new `boards_on_hand` and `meters_on_hand`. If either would be negative, **abort with a typed `InsufficientStockError`** that maps to HTTP 409 with a localized message.
3. Update the balance row.
4. Insert the `InventoryMovement` row (append-only).
5. Insert the `AuditLog` row (append-only).
6. Commit.

A database-level **`CHECK (boards_on_hand >= 0 AND meters_on_hand >= 0)`** constraint backs the application logic as a safety net — even a bug in the engine cannot drive balances negative.

**Rationale**: Row lock + check inside the transaction is the correct serialization primitive for this workload (concurrent writes for the same branch/variant are rare but must be safe). DB CHECK gives belt-and-braces.

**Alternatives considered**:
- DB triggers that decrement balances on movement insert — distributes business logic across two layers; harder to test.
- Optimistic concurrency (version column) — adds retry logic; gives no benefit at MVP scale.

---

## R8. Audit log mechanism

**Decision**: `AuditService.write({ actor, action, entityType, entityId, before, after, summaryAr, summaryEn })` is called explicitly from each command handler **inside** the same Prisma transaction as the action. Every module exposes its localized summary builders. The `audit_logs` table has no `UPDATE`/`DELETE` privileges in production (enforced by a dedicated DB role + revoked grants).

**Rationale**: Explicit calls keep human-readable summaries deterministic and i18n-correct (which DB triggers cannot do). Same-transaction semantics guarantee that an action and its audit row are committed together.

**Alternatives considered**:
- NestJS interceptor that auto-audits all mutations — convenient but produces low-quality summaries; the spec requires human-readable AR + EN strings.
- Postgres triggers — see above; cannot localize.

---

## R9. Pricing tolerance + approval

**Decision**: Tolerance is a `price_override_tolerance_percent` field on `ProductVariant` (nullable; falls back to a system setting `default_price_override_tolerance_percent` stored in a single-row `system_settings` table; default value `5.0`). Order create flow:

1. Compute `deviation_percent = abs(sale_price_per_meter - default) / default * 100`.
2. If `deviation_percent <= tolerance` → `price_override_status = within_tolerance`, `status = draft` then directly to `confirmed` on confirmation.
3. Else → `price_override_status = pending_approval`, `status = pending_price_approval`. A separate endpoint `POST /orders/:id/price-approval` (Owner/Admin only) sets `price_approved_by_user_id`, `price_approved_at`, flips `price_override_status` to `approved`. Confirmation is rejected with HTTP 409 unless `price_override_status` is `within_tolerance` or `approved`.

**Rationale**: Matches the resolved clarification, makes the approval pipeline an explicit state, and keeps inventory writes downstream of pricing approval (no movement until the order can confirm).

**Alternatives considered**: Auto-confirm with retroactive approval — rejected; conflicts with the audit-trail-first principle.

---

## R10. Order status transitions (filled the spec gap)

**Decision**: Allowed transitions for `Customer Order.status`:

```text
draft → pending_price_approval     (when price is outside tolerance)
draft → confirmed                  (when price is within tolerance and confirmed)
pending_price_approval → confirmed (after approval + confirmation)
pending_price_approval → cancelled (cancelled while still awaiting approval)
confirmed → partially_collected    (first non-zero, non-full collection)
confirmed → paid                   (collection covers required_amount)
partially_collected → paid         (later collection covers the remainder)
confirmed → cancelled              (cancellation; produces a reversal stock movement)
partially_collected → cancelled    (Owner/Admin only; produces reversals + refund record)
paid → cancelled                   (Owner/Admin only; produces reversals + refund record)
cancelled (terminal — no further transitions)
```

`paid` is **not** terminal under spec rules (cancellations may still happen for refunds), but `cancelled` is. All transitions are validated by a `OrderStatusMachine` helper; invalid transitions return HTTP 409. This will be reflected in `data-model.md` and the OpenAPI contract.

**Rationale**: Fills the "Outstanding" lifecycle gap from the clarify session without re-running clarification. Matches spec rule "Deleting confirmed financial/stock records is not allowed; use cancellation/reversal entries."

---

## R11. Form validation + shared types

**Decision**: Zod schemas authored in `packages/shared/src/schemas/`. The frontend uses them directly with `react-hook-form` (`@hookform/resolvers/zod`). The backend uses them via `nestjs-zod`'s `ZodValidationPipe` so DTOs and runtime validation come from the same source. TS types come from `z.infer<typeof Schema>` and re-export from `packages/shared/src/types/`.

**Rationale**: Eliminates schema drift between web and API. Single source of truth keeps the team honest as the spec evolves.

**Alternatives considered**: NestJS `class-validator` + frontend-only Zod — drift becomes inevitable.

---

## R12. Excel import (.xlsx)

**Decision**: Library `exceljs` (streaming parser). Two endpoints behind Owner/Admin only:

- `POST /import/dry-run` — uploads a workbook, runs the parser, returns a structured report (parsed rows, validation errors, conflicts) **without writing**.
- `POST /import/commit` — re-parses the workbook (or accepts an `import_session_id` from a stashed dry-run) and applies inserts inside a single Prisma transaction; on validation failure the whole transaction rolls back.

Per legacy sheet, the importer maps:
- `الاوردرات` → `customer_orders`
- `الجرد*` / `الوارد*` → `inventory_movements` (receipt) + recomputed balances
- `المصروفات` / `مصروفات*` → `expenses`
- `طلبيات المصنع` → `factory_ledger_entries` (linked to a Supplier the user picks before commit)

**Rationale**: Two-phase (dry-run + commit) is the only safe pattern for one-shot historical data — operators will fix the sheets, retry, fix again. `exceljs` handles `.xlsx` reliably and supports streaming for the larger sheets.

**Alternatives considered**:
- Background queue (BullMQ) for async processing — out of scope for the size of these sheets; can add later if files grow past a few MB.
- CSV-only import — would force operators to convert files manually; rejected.

---

## R13. Logging & observability

**Decision**: Pino as the NestJS logger (`nestjs-pino`); JSON logs in production, `pino-pretty` in dev. Request ID middleware (`x-request-id`). Audit logs handled separately by `AuditService` (R8) — they are domain records, not application logs.

**Rationale**: Cheap, fast, structured. Sufficient for MVP without committing to a metrics/tracing platform.

**Alternatives considered**: OpenTelemetry — useful later, deferred.

---

## R14. Deployment topology

**Decision**: Docker Compose for MVP with three services: `postgres:16`, `api` (NestJS), `web` (Next.js). A single `docker-compose.yml` plus a `docker-compose.override.yml` for dev (mounts source, hot-reload). Volumes: `postgres_data`. Reverse proxy (Caddy or Traefik) is **not** in MVP but recommended for HTTPS at deploy time — flagged for a follow-up task.

**Rationale**: Matches the user's explicit deployment choice and keeps the surface area minimal.

---

## R15. Excel migration data hygiene

**Decision (preflight rule)**: Before commit-import, the importer requires:
- A nominated **Supplier** for any factory-orders sheet.
- A nominated **Branch** when the sheet name doesn't carry one (e.g., generic "الجرد" vs branch-specific files).
- A confirmation that all referenced product codes/colors exist in the database (the dry-run report names the missing ones).

**Rationale**: The legacy spreadsheets are messy (multiple workbooks per branch, inconsistent column orders). Forcing operator confirmation prevents silently miscategorized rows.

---

## Open / deferred items

- **Constitution**: Still placeholder. Run `/speckit-constitution` to formalize and re-evaluate gates.
- **Reverse proxy / TLS**: Not in MVP scope; needed at production deploy.
- **Backups / DR**: Postgres `pg_dump` cron is the proposed MVP plan; will be detailed during implementation tasks.
- **Reporting beyond dashboard**: Listed as MVP module but only the dashboard is fully specified; the `Reports` page will surface canned exports — concrete report list pending feedback during build.
- **Concurrent edit / overpayment edge cases**: Outstanding from clarify; will be handled during `/speckit-tasks` as targeted tasks (idempotency keys + collection caps).

These do not block Phase 0 → Phase 1 transition.
