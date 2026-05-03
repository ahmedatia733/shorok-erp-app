<!--
SYNC IMPACT REPORT — 2026-05-02

Version change: 0.0.0 (placeholder template) → 1.0.0 (initial ratification)
Bump rationale: MAJOR. The previous file was the unfilled spec-kit template;
this is the first ratified version with concrete principles, so it constitutes
a backward-incompatible governance change relative to "no constitution".

Principles ratified (5):
- I.   Data Correctness Over Speed (NON-NEGOTIABLE)
- II.  Server-Authoritative Authorization (NON-NEGOTIABLE)
- III. Audit-Everything (NON-NEGOTIABLE)
- IV.  Localization Strictness
- V.   Pragmatic Simplicity

Sections added:
- Technical Constraints
- Development Workflow & Quality Gates
- Governance

Sections removed: none (templates were placeholders).

Templates aligned (✅ = no change required because the template references the
constitution dynamically; ⚠ = follow-up needed):
- ✅ .specify/templates/plan-template.md
       Constitution Check section reads gates from this file at plan time.
       The principles below are stated as testable rules; the existing
       "Constitution Check" gate text remains compatible without edits.
- ✅ .specify/templates/spec-template.md
       No principle requires a new mandatory spec section beyond what is
       already in spec.md (Roles, Constraints > Privacy and Safety,
       Constraints > Data Integrity, Default Locales). No edit.
- ✅ .specify/templates/tasks-template.md
       Task categories already cover testing, validation, and audit. No edit.
- ✅ .specify/templates/commands/*  (none present in this install)
- ✅ specs/main/plan.md
       The "Constitution Check" section already lists these five rules as
       de-facto principles; once this file is ratified, that gate flips
       from "PASS with placeholder constitution" to "PASS". No content edit
       to plan.md required for ratification — to be re-confirmed by
       /speckit-analyze.
- ✅ specs/main/spec.md, research.md, data-model.md, contracts/
       Existing content is consistent with the ratified principles.
- ✅ shorok-erp-app/CLAUDE.md
       Already references specs/main/plan.md and companions; no edit.

Deferred items: none.
-->

# Shorok ERP Constitution

## Core Principles

### I. Data Correctness Over Speed (NON-NEGOTIABLE)

Financial and stock state MUST be correct, reconcilable, and auditable before
it is fast or convenient. Concretely:

- All money values MUST be stored and computed as fixed-point decimal
  (PostgreSQL `NUMERIC`, Prisma `Decimal`, `decimal.js` arithmetic). The use
  of binary floating point for amounts, prices, or balances is forbidden.
- Branch on-hand stock MUST never be allowed to go negative. This is enforced
  at TWO layers: (a) an application-level transactional engine that holds a
  row-level lock on the balance row before computing the new balance and
  rejects any operation that would drive it below zero; (b) a database-level
  `CHECK (boards_on_hand >= 0 AND meters_on_hand >= 0)` constraint as a
  safety net. Either layer failing alone is a defect; both must agree.
- Confirmed financial or stock records (orders past `DRAFT`, posted
  collections, posted inventory movements, factory ledger rows) MUST NOT be
  hard-deleted. Corrections are made by appending compensating
  cancellation/reversal entries.
- Derived fields (e.g. `meters_quantity`, `required_amount`,
  `remaining_amount`, supplier `running_balance`) MUST be computed
  deterministically from inputs. They may be stored for read performance,
  but a recompute MUST always produce the same value; a periodic
  reconciliation check is required.

Rationale: the system replaces years of Excel sheets that the business is
already running on. Any silent corruption — a negative balance, a lost
collection, a mis-summed ledger — destroys the migration's value and erodes
trust faster than any feature wins it back.

### II. Server-Authoritative Authorization (NON-NEGOTIABLE)

The backend is the sole authority for who may do what. Concretely:

- Every state-changing endpoint MUST pass through `JwtAuthGuard`, then
  `RolesGuard`, then (for branch-scoped resources) `BranchScopeGuard`.
- The frontend MAY hide UI for unauthorized actions but MUST NOT be the only
  thing that prevents them.
- Branch scoping is enforced from `User.allowed_branches` matched against the
  request's `branchId`. `OWNER` users implicitly bypass branch scoping; no
  other role does.
- JWT access tokens are short-lived (minutes); refresh tokens are opaque,
  stored hashed, rotated on every refresh, and revocable by deleting the row.

Rationale: the system holds money and inventory; a privileged client (or a
forged frontend) cannot be allowed to perform actions outside the user's
role. Centralizing authorization in guards keeps it testable and prevents
drift across modules.

### III. Audit-Everything (NON-NEGOTIABLE)

Every state-changing action MUST produce an `AuditLog` row in the same
database transaction as the action it describes. Concretely:

- The `audit_logs` table is append-only. Production database privileges MUST
  revoke `UPDATE` and `DELETE` on this table.
- Each row carries `human_readable_summary_ar` AND `human_readable_summary_en`
  so the UI can render the active locale directly without re-translating.
- The audit row's transaction commits with the action; if the audit write
  fails, the action MUST roll back.
- Logins, logouts, imports, approvals, cancellations, and corrections are all
  audited, not only "create"/"update". The action enum is fixed at the
  data-model layer.

Rationale: the spec promises an append-only audit trail visible in the UI.
Audit rows produced after the fact (interceptors, async writers, DB triggers
that cannot localize) cannot satisfy that promise. Same-transaction writes
are the only mechanism that guarantees an action and its log are inseparable.

### IV. Localization Strictness

The system is Arabic-first (`ar-EG`, RTL) with English (`en`, LTR) as a
toggle. Concretely:

- No user-visible string MAY be hardcoded in code. All UI text comes from
  translation message catalogs (`apps/web/messages/{ar,en}.json`,
  `apps/api/src/i18n/{ar,en}/`). A lint rule MUST enforce this in
  `apps/web` JSX and `apps/api` controller responses.
- Translation keys (e.g. `orders.create.title`) MUST NEVER be visible to
  users. Missing translations fail loud in development and fall back to the
  English string in production with a logged warning — never to the key
  name.
- The frontend renders RTL by setting `<html dir="rtl">` from the locale
  segment AND uses Tailwind logical properties (`ms-`, `me-`, `ps-`, `pe-`,
  `start-`, `end-`, `text-start`, `text-end`). Direction-specific Tailwind
  utilities (`ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`) are forbidden in
  `apps/web` and enforced by lint.
- Currency, date, and number formatting MUST follow the active locale via
  `Intl.NumberFormat` / `Intl.DateTimeFormat`. Arabic copy uses clear
  Egyptian business language; English copy is simple and professional.

Rationale: the operators are Arabic-speaking branch and warehouse staff.
A single hardcoded English string, a single mirrored-incorrectly layout, or
a translation key bleeding into the UI breaks the product for them in a
visible, embarrassing way that they cannot work around.

### V. Pragmatic Simplicity

Build the smallest thing that satisfies the spec. Concretely:

- One API service, one database, one web app. No microservices, no event
  bus, no read replicas, no separate worker fleet for MVP.
- Add a dependency, library, framework, or pattern only when an existing one
  cannot do the job; record the decision (and the rejected alternatives) in
  `research.md`.
- Background jobs, queues, and caches are introduced when measured load
  requires them — not before.
- Speculative abstractions, "future-proof" interfaces, and feature flags for
  unbuilt features are not allowed. YAGNI.

Rationale: the goal is to replace the Excel workflows completely and
correctly within MVP. Every layer of incidental complexity is a layer that
must be tested, documented, and justified to operators if it ever leaks into
their experience.

## Technical Constraints

The constitution also fixes these project-wide technical constraints. They
are part of the gate; changes require an amendment.

- **Stack**: TypeScript on Node.js 20 LTS. Frontend Next.js (App Router) +
  Tailwind + shadcn/ui. Backend NestJS. Database PostgreSQL 16 via Prisma.
  Monorepo: pnpm workspaces + Turborepo. Single shared types/validation
  package (`packages/shared`) using Zod as the source of truth.
- **Auth**: phone-first login (E.164, default country EG); password +
  bcrypt(12); JWT access + opaque rotating refresh tokens; refresh stored
  as `httpOnly`/`Secure`/`SameSite=Lax` cookie; access in
  `Authorization: Bearer …`.
- **Currency**: EGP only in MVP. No multi-currency abstraction.
- **Locales**: `ar-EG` (default, RTL) and `en` (LTR). No third locale in MVP.
- **Money types**: `NUMERIC(14,2)` in Postgres; `Decimal` in Prisma; never
  `number` for currency in TypeScript.
- **Append-only tables**: `inventory_movements`, `order_collections`,
  `factory_ledger_entries`, `audit_logs`. Production role lacks
  `UPDATE`/`DELETE` privileges on these tables.
- **Excel migration**: a one-shot, two-phase importer (`/import/dry-run` →
  `/import/commit`). Treat the imported workbooks as untrusted input;
  validate every row; the commit phase runs inside a single Postgres
  transaction.
- **Deployment**: Docker Compose for the MVP. A reverse proxy / TLS
  termination layer is required for any non-local deployment; specifying it
  is an implementation task, not a constitutional decision.

## Development Workflow & Quality Gates

- **Spec-driven**: every feature passes through `/speckit-specify` →
  `/speckit-clarify` → `/speckit-plan` → `/speckit-tasks` →
  `/speckit-implement`. Skipping clarify is permitted only for an explicit
  exploratory spike, with an explicit acknowledgement of the rework risk.
- **Design-spec-first UI**: no UI implementation begins on a feature until
  `docs/ui-design/outputs/<feature-name>/design.md` exists and includes
  screen purpose, layout, components, all states (loading/empty/error/
  success), user actions, RTL/LTR behavior, Arabic copy, English copy, and
  edge cases. The shared design system at
  `docs/ui-design/outputs/00-design-system/design.md` MUST exist before any
  feature design.
- **Testing**:
  - Unit: Jest. Required for the inventory engine, order state machine,
    pricing tolerance/approval logic, and any non-trivial pure function in
    `packages/shared`.
  - Integration: Jest + a real PostgreSQL test schema. Required for every
    write endpoint. Mocks of the database are not accepted as substitutes.
  - End-to-end: Playwright. Required for at minimum: login, create-order
    (within tolerance), create-order (out of tolerance with approval),
    record-collection, receive-inventory, daily-stock-count,
    record-expense, record-factory-purchase, language switch (AR ↔ EN with
    RTL/LTR mirroring).
- **Code review**: every PR MUST pass type-check, lint (including the
  i18n-string and direction-utility rules), unit + integration tests, and
  Playwright E2E. A reviewer who is not the author MUST approve before merge.
- **Constitution Check on plans**: every `/speckit-plan` execution MUST
  evaluate against this file. Violations require entries under
  Complexity Tracking with explicit rationale and rejected simpler
  alternatives; an unjustified violation blocks the plan.

## Governance

- **Authority**: this constitution supersedes ad-hoc preferences and
  individual code-review opinions. Where this document and another
  rule conflict, this document wins until amended.
- **Amendment procedure**: amendments are proposed via pull request that
  modifies `.specify/memory/constitution.md`, includes a Sync Impact Report
  (HTML comment at the top of the file), updates dependent templates and
  artifacts in the same PR, and bumps the version per semver:
  - **MAJOR**: principle removed, redefined incompatibly, or a non-negotiable
    rule relaxed.
  - **MINOR**: new principle or section added; existing guidance materially
    expanded.
  - **PATCH**: clarifications, wording, typo fixes, non-semantic refinements.
- **Compliance review**: every six months (next review on or before
  2026-11-02), the principles above are reviewed against the running system.
  Drift between the constitution and the codebase MUST be closed by either
  amending the constitution or fixing the code.
- **Runtime guidance**: `shorok-erp-app/CLAUDE.md` is the agent-facing entry
  point. It MUST point to `specs/<branch>/plan.md` for the active feature
  plan; it MUST NOT duplicate normative content from this file.

**Version**: 1.0.0 | **Ratified**: 2026-05-02 | **Last Amended**: 2026-05-02
