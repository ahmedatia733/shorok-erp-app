<!-- SPECKIT START -->
**ACTIVE FEATURE — all Elshrouq ERP redesign work MUST follow
`specs/elshrouq-erp-redesign/`** (constitution v2.0.0 applies, Principles
VI–VIII: single posting path, posted-record immutability, configuration
over hardcoding). Start with `specs/elshrouq-erp-redesign/spec.md`, then
`plan.md` and `tasks.md` in the same directory. Implementation is gated:
do not modify production code until the task is explicitly approved by
Ahmed Attia. Arabic UI terms come from
`specs/elshrouq-erp-redesign/glossary-ar-en.md`.

Historical record of the operations MVP (baseline `75b9b70`, still the
source of truth for already-shipped operations behavior):
`specs/main/plan.md`. Companion artifacts in that directory:
- `spec.md` — feature specification (source of truth)
- `research.md` — Phase 0 decisions (stack, transactional engine, auth, i18n, etc.)
- `data-model.md` — entities, enums, integrity rules, order state machine
- `contracts/openapi.yaml` + `contracts/endpoints.md` — API contract
- `quickstart.md` — local dev / smoke-check guide
<!-- SPECKIT END -->
