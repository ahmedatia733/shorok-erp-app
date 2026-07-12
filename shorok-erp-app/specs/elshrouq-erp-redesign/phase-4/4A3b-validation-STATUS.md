# Phase 4A-3b — Config Foundation Validation Status (Public-Safe)

**Date:** 2026-07-12 · **Type:** Validation only. No DB changes.

> Aggregate counts and account/role names only. No DB URLs, backup paths, raw
> SQL output, customer/supplier data, or balances. A detailed note is retained
> privately under `private-notes/` (untracked).

## Scope
Validate the Phase 4A-3a config foundation (system roles + OPENING_EQUITY) —
the party guard, the document flows, the reports/pages, and production integrity.
Integration tests ran against a **local** database (per-test isolated schemas,
dropped on teardown), **not** production. The deployed smoke was **read-only**.

## Focused integration tests — all passed
| Suite | Result |
|---|---|
| posting-engine | 15/15 |
| purchase-posting | 5/5 |
| sales-posting | 7/7 |
| expense-posting | 9/9 |
| expenses | 9/9 |
| reversal-hardening | 6/6 |
| reversal-documents | 7/7 |
| purchase-invoices-hotfix | 6/6 |
| **Total** | **64 / 64 passed** |

## Party guard validated
- ✅ AR/AP control account **without** a party → **rejected**.
- ✅ AR/AP control account **with** a party → **accepted**.
- ✅ Non-control accounts do **not** require a party.

## Document flows validated
- ✅ Purchase confirm posts AP with a **SUPPLIER** party.
- ✅ Sales confirm posts AR with a **CUSTOMER** party.
- ✅ Expense (supplier-credit) posts AP with a **SUPPLIER** party.
- ✅ Reversals **mirror** the original party.

## Deployed read-only smoke — all 200
Reports (trial balance, balance sheet, income statement, cash flow, dashboard),
journal, statement, suppliers, customers, purchase invoices, sales invoices,
expenses, inventory movements. Reports resolve accounts by category/type (not
`system_role`), so role assignment changed no report output.

## Production DB integrity — unchanged
| Check | Result |
|---|---|
| accounts with a system_role | **7** |
| account 3400 | still **OPENING_EQUITY** (EQUITY/leaf/active) |
| VAT_OUTPUT | still **unassigned** |
| OPENING journal entries | **0** |
| Unbalanced entries | **0** |
| Journal entries / lines | unchanged |
| avg_cost aggregate | **unchanged** |

## Confirmations
- ✅ No migrations · ✅ No deploy · ✅ No production data changed · ✅ No production
  test artifacts (tests were local + auto-dropped; deployed smoke was read-only).

## Recommendation
**Phase 4A-3 is fully validated** — the party guard behaves correctly on the
newly-tagged AR/AP control accounts, all document flows and reversals pass,
reports are unaffected, and production integrity is intact.
