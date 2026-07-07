<!--
SYNC IMPACT REPORT — 2026-07-07

Version change: 1.0.0 → 2.0.0
Bump rationale: MAJOR. Two backward-incompatible governance changes:
(1) The product identity changes from "one-off Shorok MVP replacing Excel"
    to "configurable Otonom ERP product with Elshrouq as first tenant".
    This redefines the scope of Principle V (Pragmatic Simplicity/YAGNI):
    configurability mandated by the ratified product direction is now
    in-scope work, not speculative abstraction. Principle V itself is
    retained but its rationale is qualified by new Principle VIII.
(2) The append-only table list in Technical Constraints is restated in
    role-based terms because the redesign retires two of the four named
    tables (order_collections, factory_ledger_entries) in favor of
    GL-posted documents.

Principles added (3):
- VI.   Single Posting Path (NON-NEGOTIABLE)
- VII.  Posted-Record Immutability (NON-NEGOTIABLE)
- VIII. Configuration Over Hardcoding

Principles retained unchanged (5): I, II, III, IV, V (V with a scope note
referencing VIII).

Sections modified:
- Technical Constraints: append-only list restated role-based; currency
  constraint restated as "single currency per company (EGP default),
  stored in CompanyProfile and locked after first posting".
- Development Workflow & Quality Gates: added accounting test gates
  (engine invariants, golden-path Dr/Cr assertions, trial-balance
  property test, migration reconciliation dry-run).

Templates aligned:
- ✅ .specify/templates/plan-template.md — Constitution Check reads this
     file dynamically; new principles VI–VIII become additional gates
     automatically. No template edit required.
- ✅ .specify/templates/spec-template.md — no new mandatory section; the
     redesign spec carries posting rules as Functional Requirements.
- ✅ .specify/templates/tasks-template.md — task categories already cover
     testing/validation/audit; accounting gates map onto them.
- ✅ specs/main/* — historical record of the operations MVP; grandfathered
     under v1.0.0. New work MUST follow specs/elshrouq-erp-redesign/.
- ✅ shorok-erp-app/CLAUDE.md — updated in the same commit to point new
     work at specs/elshrouq-erp-redesign/.

Known drift accepted at ratification time: the CURRENT codebase violates
VI and VII (parallel ledgers, optional posting, hard-deletable journal
entries) and VIII (hardcoded client data). This drift is the subject of
the elshrouq-erp-redesign feature; it is documented there and closed by
its phases, not by amending this file further.

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
- Changes to accounting-critical configuration (posting profiles, tax
  profiles, costing settings, period open/close, document numbering) are
  state-changing actions under this principle and MUST be audited with
  before/after snapshots.

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
- Arabic accounting terminology MUST follow the ratified glossary
  (`specs/elshrouq-erp-redesign/glossary-ar-en.md`): Egyptian-market terms
  (e.g. حسابات العملاء، ترحيل، سند قبض، دليل الحسابات، المخازن), Western
  digits for numerals, money at 2 decimal places.

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
- Scope note (v2.0.0): configurability that Principle VIII mandates for the
  ratified product direction (multi-company reuse) is in-scope required
  work, not speculation. YAGNI continues to apply to everything beyond
  Principle VIII's enumerated configuration areas (e.g. multi-currency,
  custom role builders, cross-tenant features remain out until a real
  requirement lands).

Rationale: the goal is to replace the Excel workflows completely and
correctly. Every layer of incidental complexity is a layer that must be
tested, documented, and justified to operators if it ever leaks into their
experience.

### VI. Single Posting Path (NON-NEGOTIABLE)

All financial impact flows through journal entries created by one posting
engine; all inventory impact flows through stock movement records created by
one inventory engine. Concretely:

- Exactly one application service (the PostingEngine) MAY insert
  `journal_entries`/`journal_lines` rows. Direct writes from controllers or
  other services are forbidden and MUST be blocked by lint rule and code
  review.
- Exactly one application service (the InventoryEngine) MAY change stock
  balances. Creating movement rows without going through the engine is
  forbidden — a movement row and its balance effect are inseparable.
- Every posting MUST be balanced (Σdebit == Σcredit), atomic (document +
  journal + inventory + audit in one database transaction), and mandatory
  (no user-facing option may skip the financial or inventory effect of a
  posted document).
- Parallel ledgers are forbidden. Customer and supplier balances derive from
  GL control accounts with party dimensions on journal lines; cash and bank
  balances derive from GL treasury accounts. No table may store a running
  financial balance as a source of truth.
- Reports read posted journal lines and stock movements only. No report
  figure may originate from UI-side arithmetic or from unposted documents.

Rationale: the first accounting layer failed precisely because postings were
optional, scattered, and duplicated across four disagreeing subsystems. One
enforced path is the only architecture under which the books can be trusted.

### VII. Posted-Record Immutability (NON-NEGOTIABLE)

A posted financial document is a historical fact. Concretely:

- Document lifecycle is `DRAFT → POSTED → REVERSED`. Posted documents and
  their journal entries MUST NOT be edited or hard-deleted; no API endpoint
  may exist that does so.
- Corrections create reversal entries linked to the original
  (`reversal_of_id`), with a mandatory reason, in the same or a later open
  period.
- Postings MUST land in an OPEN financial period. Closing a period blocks
  further postings into it; reopening is OWNER-only, requires a reason, and
  is audited.
- Posted documents permanently store the resolved values used at posting
  time (tax rate, unit cost, account ids, party, numbering). Later
  configuration changes MUST NOT alter what a posted document says — no
  silent retroactivity, ever.

Rationale: accountants, auditors, and the tax authority reason over books
that do not change behind their backs. Effective-dated configuration plus
reversal-based correction gives full flexibility going forward with zero
rewriting of the past.

### VIII. Configuration Over Hardcoding

Elshrouq ERP is a configurable Otonom product; Elshrouq is its first tenant,
not its definition. Concretely:

- No client-specific value may live in code: company name, logo, brand
  colors, tax rates and registration, chart of accounts, account mappings,
  banks, vaults, branches, warehouses, items, units of measure and their
  conversion factors, expense categories, document numbering, print
  templates, roles assignments, locale defaults. All of these live in
  configuration (CompanyProfile, settings tables, tenant seed packs).
- Client-specific catalog data ships as a per-tenant seed pack, never in
  shared seeds or migrations.
- Configuration that affects posting (tax profiles, posting profiles,
  costing method, print templates) is versioned with `effective_from`; the
  engine resolves configuration as of the document's posting date.
- Accounting-critical configuration is permission-gated: posting profiles,
  costing, and period reopening are OWNER-level; tax and expense-category
  mapping are ACCOUNTANT-level or above. Normal users MUST NOT be able to
  edit accounting configuration.
- Permission definitions (what each role can do) are code; permission
  assignments (who holds which role) are configuration.
- Deployment model: separate database per client company first; the schema
  carries a `CompanyProfile` from day one and avoids cross-tenant globals so
  a later SaaS consolidation does not require a redesign.

Rationale: the ratified product direction is reuse across companies with
custom branding and per-company accounting policy. Every hardcoded client
assumption is future rework and a defect under this constitution.

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
- **Currency**: single currency per company; EGP is the default. The
  currency lives in `CompanyProfile` and is locked once the company has any
  posted document. No multi-currency abstraction.
- **Locales**: `ar-EG` (default, RTL) and `en` (LTR). No third locale.
- **Money types**: `NUMERIC(14,2)` in Postgres; `Decimal` in Prisma; never
  `number` for currency in TypeScript.
- **Append-only data**: journal entries and journal lines, stock movement
  records, and audit logs are append-only (status transitions permitted;
  content edits and hard deletes forbidden). Production role lacks
  `UPDATE`/`DELETE` privileges on these tables except the columns required
  for status transitions.
- **Excel migration**: importers are two-phase (`dry-run` → `commit`),
  treat workbooks as untrusted input, validate every row, and commit inside
  a single Postgres transaction. Opening-balance imports MUST produce a
  balanced OPENING journal entry set and a reconciliation report.
- **Deployment**: Docker Compose for single-tenant deployments. A reverse
  proxy / TLS termination layer is required for any non-local deployment;
  specifying it is an implementation task, not a constitutional decision.

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
  feature design. For the redesign feature,
  `specs/elshrouq-erp-redesign/design-system.md` supersedes and feeds that
  location.
- **Testing**:
  - Unit: Jest. Required for the inventory engine, the posting engine
    (every invariant: balance, period lock, immutability, idempotency),
    order state machine, pricing tolerance/approval logic, and any
    non-trivial pure function in `packages/shared`.
  - Integration: Jest + a real PostgreSQL test schema. Required for every
    write endpoint. Mocks of the database are not accepted as substitutes.
    Every posting flow MUST have a golden-path test asserting the exact
    Dr/Cr journal lines, stock deltas, and cost-basis effect.
  - Property test: any generated sequence of valid postings keeps the trial
    balance balanced and inventory valuation reconciled to the inventory GL
    account. Runs in CI.
  - Migration: the legacy-data migration pipeline MUST pass a dry-run
    reconciliation (old stored balances == new derived balances) on a
    sanitized client snapshot before it may run against production.
  - End-to-end: Playwright. Required for at minimum: login, the full
    trading cycle (purchase invoice post → stock increase → sales invoice
    post with stock validation → receipt voucher → payment voucher →
    expense → P&L reflects all of it), period close blocking a post,
    reversal flow, and language switch (AR ↔ EN with RTL/LTR mirroring).
- **Code review**: every PR MUST pass type-check, lint (including the
  i18n-string, direction-utility, and no-direct-journal-write rules), unit +
  integration tests, and Playwright E2E. A reviewer who is not the author
  MUST approve before merge.
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
  2027-01-07), the principles above are reviewed against the running system.
  Drift between the constitution and the codebase MUST be closed by either
  amending the constitution or fixing the code. The drift documented in the
  2026-07-07 Sync Impact Report is tracked by the elshrouq-erp-redesign
  feature and is exempt from this clause until that feature's phases close
  it.
- **Runtime guidance**: `shorok-erp-app/CLAUDE.md` is the agent-facing entry
  point. It MUST point to `specs/<branch>/plan.md` for the active feature
  plan; it MUST NOT duplicate normative content from this file.

**Version**: 2.0.0 | **Ratified**: 2026-05-02 | **Last Amended**: 2026-07-07
