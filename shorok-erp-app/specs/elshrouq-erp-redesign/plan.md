# Implementation Plan: Elshrouq ERP Redesign — Configurable Accounting & Inventory Product

**Branch**: `elshrouq-erp-redesign` | **Date**: 2026-07-07 | **Spec**: [./spec.md](./spec.md)
**Input**: Feature specification from `/specs/elshrouq-erp-redesign/spec.md`
**Approval state**: Plan approved for generation (Ahmed Attia, 2026-07-07). **Implementation NOT approved** — `/speckit-implement` is gated on separate explicit approval. The two Phase-1 P0 hotfixes are documented here but MUST NOT be implemented until that approval.

## Summary

Replace the untrusted post-baseline accounting layer with a single-posting-path architecture: one PostingEngine through which every financial document posts (balanced, atomic, mandatory, period-locked, immutable-with-reversals), party dimensions on journal lines replacing four parallel ledgers, treasury accounts inside the chart of accounts, moving weighted-average costing, receipt/payment vouchers with open-item allocation, GL-only reports — all productized behind a two-tier configuration model (onboarding wizard + admin settings with effective-date versioning) so the system deploys for future Otonom clients without code changes. Technical approach and all decisions are ratified in [technical-spec-en.md](./technical-spec-en.md) (A1–A11) and [admin-configuration.md](./admin-configuration.md); this plan sequences them.

## Technical Context

**Language/Version**: TypeScript on Node.js 20 LTS (existing)
**Primary Dependencies**: Next.js 14 App Router + Tailwind, NestJS, Prisma, Zod shared schemas (`packages/shared`), next-intl / nestjs-i18n, decimal.js — all existing; no new runtime dependencies planned (Constitution V)
**Storage**: PostgreSQL 16 via Prisma; hand-written SQL migrations only, expand-and-contract pattern (A2)
**Testing**: Jest unit + integration (real PostgreSQL test schema), Playwright E2E, new CI property test (trial balance + valuation reconciliation) per Constitution v2.0.0 quality gates
**Target Platform**: Docker Compose single-tenant deployments (Railway today); separate DB per client company (A8)
**Project Type**: Web application — existing monorepo `shorok-erp-app/` (apps/api, apps/web, packages/shared)
**Performance Goals**: Correctness over speed (Constitution I). Posting latency target < 2s p95 per document; reports < 5s p95 on 100k journal lines (indexes specified in technical spec §Technical Recommendations)
**Constraints**: No parallel ledgers, no stored running balances, no direct journal writes outside engine (lint-enforced), no client literals in code, posted records immutable, config changes never retroactive
**Scale/Scope**: SME scale (≤ ~50 users, ≤ ~100k journal lines/yr per tenant); ~20 redesigned screens + 15-screen settings module; 12 new / 8 modified / 4 removed entities

## Constitution Check

*GATE evaluated against constitution v2.0.0 — pre-Phase-0 and re-checked post-design.*

| Principle | Gate result | Evidence |
|---|---|---|
| I. Data Correctness | ✅ PASS | Decimal-only money retained; InventoryEngine reuse mandated (FR-002); derived-balance recompute = FR-030 valuation reconciliation invariant |
| II. Server-Authoritative Authorization | ✅ PASS | Central permission map (technical spec §RBAC); guards unchanged; config screens permission-gated (FR-020) |
| III. Audit-Everything | ✅ PASS | PostingEngine writes audit in-transaction (FR-001); config changes audited with snapshots (Constitution III bullet 5) |
| IV. Localization Strictness | ✅ PASS | Ratified glossary (`glossary-ar-en.md`); A11 removes Arabic literals from API business logic — tracked as explicit Phase-3/6 tasks |
| V. Pragmatic Simplicity | ✅ PASS | No new services/queues/deps; versioning limited to posting-affecting config only (RA-6); VIII scope note honored |
| VI. Single Posting Path | ✅ PASS (this feature exists to close current drift) | FR-001/002/005; lint rule task in Phase 2 |
| VII. Posted-Record Immutability | ✅ PASS (same) | FR-003/004; delete endpoints removed in Phase 3 |
| VIII. Configuration Over Hardcoding | ✅ PASS (same) | FR-020..023; tenant seed packs Phase 7; SC-006 grep gates |

**Known current-codebase drift** (documented in constitution Sync Impact Report): violations of VI/VII/VIII exist in shipped code; this plan's phases are the remediation. No new violations introduced by the design → Complexity Tracking empty.

## Project Structure

### Documentation (this feature)

```text
specs/elshrouq-erp-redesign/
├── spec.md                  # Feature specification (source of truth)
├── plan.md                  # This file
├── client-spec-ar.md        # Client-facing Arabic specification (send for approval)
├── client-questions.md      # 4 blocking + 13 onboarding client questions
├── glossary-ar-en.md        # Ratified Arabic/English terminology
├── technical-spec-en.md     # Architecture decisions, data model, engine, flows, RBAC, migration, testing
├── admin-configuration.md   # 18 configuration areas, effective-date framework, setup wizard, seed packs
├── ui-ux-spec.md            # IA, 20+ screens, states, posting-preview component, settings module
├── design-system.md         # Tokens, typography, RTL rules, components, print templates, design prompts
├── data-model.md            # Phase-1 design output: entity/field/relationship detail
├── contracts/endpoints.md   # Phase-1 design output: API surface delta
├── quickstart.md            # Phase-1 design output: dev bring-up for this feature
└── tasks.md                 # /speckit-tasks output (generated, NOT executed)
```

*research.md intentionally omitted*: all Phase-0 unknowns were resolved during the analysis/specification cycle and are recorded with decisions + rationale in `technical-spec-en.md` (A1–A11, RA-1–RA-10). No NEEDS CLARIFICATION items remain that research can resolve; the four remaining unknowns are client facts (see Gate below).

### Source Code (repository root: `shorok-erp-app/`)

```text
apps/api/src/
├── modules/
│   ├── posting/            # NEW: PostingEngine, invariants, reversal service, period guard
│   ├── periods/            # NEW: financial periods, close/reopen
│   ├── configuration/      # NEW: company profile, posting/tax profiles, expense categories,
│   │                       #      numbering series, print templates, costing settings (versioned)
│   ├── treasury/           # NEW: receipt/payment vouchers + allocations; replaces payments/
│   ├── returns/            # NEW: sales/purchase returns (v1.0 per RA-8)
│   ├── sales-invoices/     # REBUILT posting flow on engine
│   ├── purchase-invoices/  # REBUILT posting flow on engine (fixes P0 stock bypass)
│   ├── expenses/           # REBUILT: mandatory posting via category mapping
│   ├── inventory/          # KEPT: InventoryEngine (single stock path) + costing hook
│   ├── journal/            # KEPT tables; delete endpoint removed; manual entries via engine
│   ├── reports/            # REPOINTED at unified GL
│   └── (customers/suppliers/orders/products/branches/users/audit — kept, FK fixes)
├── prisma/migrations/      # Expand-and-contract SQL migrations (Phases 2–4, 7)
apps/web/app/[locale]/(app)/
├── (sales|purchasing|treasury|expenses|inventory|accounting|reports)/  # per ui-ux-spec IA
└── settings/               # NEW 15-screen settings module + setup wizard shell
packages/shared/src/schemas/ # Zod schemas per contracts delta
```

**Structure Decision**: retain the existing monorepo layout (A1); all additions are NestJS modules and App Router routes inside the current apps — no new packages, no new services.

## Phase Roadmap (delivery sequencing)

| Phase | Scope (references) | Exit gate |
|---|---|---|
| **0. Specs** | This package | ✅ Done — Ahmed approval 2026-07-07; client approval of `client-spec-ar.md` pending |
| **1. Quarantine hotfixes** ⚠️ *implementation gated* | Only: purchase-confirm stock via InventoryEngine; Σdebit==Σcredit assertion in purchase posting. Legacy ledgers marked read-only in UI | Live data stops corrupting; **requires separate explicit approval** |
| **2. Foundation** | posting/ periods/ configuration/ modules; party dims; account flags; sequences; permission map; lint rule (FR-001..006, 020, 023) | Engine invariant suite green |
| **3. Documents** | Rebuild invoice/expense posting on engine; costing; returns; orders→customer FK; remove journal delete (FR-010..015) | Golden-path Dr/Cr tests green; zero account pickers |
| **4. Treasury & migration** | Vouchers + allocations; treasury accounts; legacy-ledger data migration + reconciliation (FR-012, 040) | Zero-diff reconciliation on client snapshot |
| **5. Reports** | All reports on GL; ledger opening/running; VAT in/out; aging; valuation-vs-GL (FR-030) | Trial balance + valuation invariants on migrated data |
| **6. UX & settings** | New IA, design-system rollout, settings module + wizard, posting preview, print templates, states (ui-ux-spec) | Client walkthrough sign-off of User Story 1 |
| **7. Productization** | UoM config; tenant seed packs; branding end-to-end; Elshrouq data → tenant seed (FR-021, 022) | Second demo tenant < 1 day (SC-005) |

Sequencing rule: a phase starts only after the previous phase's exit gate passes **on a copy of the client's real data**.

## Complexity Tracking

No constitution violations to justify — table intentionally empty.

## Gate for /speckit-tasks

Ready. Outstanding inputs that do NOT block task generation but block **Phase 4 execution**: client answers ق١–ق٤ (`client-questions.md`).
