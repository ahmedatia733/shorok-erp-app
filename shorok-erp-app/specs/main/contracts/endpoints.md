# API Contract Summary — Shorok ERP MVP

Base URL: `/api/v1`. All endpoints (except `POST /auth/login` and `POST /auth/refresh`) require `Authorization: Bearer <accessToken>`. All branch-scoped endpoints are filtered by the user's `UserBranchAccess` (OWNER bypasses).

The full machine-readable schema is in `openapi.yaml`. This file is the human-readable index.

---

## Auth

| Method | Path                        | Auth   | Roles | Body / Notes |
|--------|-----------------------------|--------|-------|--------------|
| POST   | `/auth/login`               | none   | any   | `{ phone, password }` → `{ accessToken }`; refresh token set as httpOnly cookie |
| POST   | `/auth/refresh`             | cookie | any   | rotates refresh; returns new access token |
| POST   | `/auth/logout`              | bearer | any   | revokes the current refresh token |
| GET    | `/auth/me`                  | bearer | any   | returns current user + roles + allowed_branches |

Errors:
- `401 invalid_credentials`
- `401 token_expired`
- `403 user_disabled`

---

## Users (OWNER only)

| Method | Path           | Body |
|--------|----------------|------|
| GET    | `/users`       | list with paging |
| POST   | `/users`       | create user (phone, name, role, password, allowed_branches) |
| GET    | `/users/:id`   | |
| PATCH  | `/users/:id`   | partial update; cannot change own role |
| POST   | `/users/:id/disable` | |
| POST   | `/users/:id/enable`  | |
| POST   | `/users/:id/password-reset` | OWNER sets a new password |

---

## Branches (OWNER only)

| Method | Path | Body |
|--------|------|------|
| GET    | `/branches` | |
| POST   | `/branches` | `{ name_ar, name_en, location? }` |
| PATCH  | `/branches/:id` | |
| POST   | `/branches/:id/deactivate` | |

---

## Products

| Method | Path                          | Roles                         |
|--------|-------------------------------|-------------------------------|
| GET    | `/products/skus`              | any authenticated             |
| POST   | `/products/skus`              | OWNER                         |
| PATCH  | `/products/skus/:id`          | OWNER                         |
| GET    | `/products/variants`          | any authenticated; supports `?skuId=` |
| POST   | `/products/variants`          | OWNER                         |
| PATCH  | `/products/variants/:id`      | OWNER                         |

---

## Inventory

All routes are branch-scoped via the `branchId` query/path parameter.

| Method | Path                                       | Roles                                  | Notes |
|--------|--------------------------------------------|----------------------------------------|-------|
| GET    | `/inventory/balances?branchId=…`           | any authenticated for that branch      | per-variant balances + low-stock flag |
| GET    | `/inventory/movements?branchId=…&…`        | any authenticated for that branch      | paged ledger; filters: variant, type, date range |
| POST   | `/inventory/receipts`                       | OWNER, BRANCH_MANAGER, WAREHOUSE       | `{ branchId, productVariantId, boardsQuantity, note? }` |
| POST   | `/inventory/adjustments`                    | OWNER, BRANCH_MANAGER, WAREHOUSE       | `{ branchId, productVariantId, boardsDelta, note }` |
| POST   | `/inventory/counts`                         | OWNER, BRANCH_MANAGER, WAREHOUSE       | `{ branchId, lines: [{ variantId, countedBoards }] }` → posts COUNT_CORRECTION movements |

Errors specific to inventory writes:
- `409 insufficient_stock` (any flow that would drive a balance negative)
- `409 invalid_movement` (e.g., zero quantity)

---

## Orders

Branch-scoped.

| Method | Path                                   | Roles                                     |
|--------|----------------------------------------|-------------------------------------------|
| GET    | `/orders?branchId=…&status=…`          | any authenticated for that branch          |
| GET    | `/orders/:id`                          | any authenticated for that branch          |
| POST   | `/orders`                              | OWNER, BRANCH_MANAGER                     |
| PATCH  | `/orders/:id`                          | OWNER, BRANCH_MANAGER (only while DRAFT)  |
| POST   | `/orders/:id/confirm`                  | OWNER, BRANCH_MANAGER                     |
| POST   | `/orders/:id/cancel`                   | OWNER (any state); BRANCH_MANAGER (CONFIRMED only) |
| POST   | `/orders/:id/price-approval`           | OWNER                                     |
| POST   | `/orders/:id/collections`              | OWNER, BRANCH_MANAGER, ACCOUNTANT         |

`POST /orders` body:

```json
{
  "branchId": "uuid",
  "orderDate": "2026-05-02",
  "customerName": "string",
  "productVariantId": "uuid",
  "boardsQuantity": "decimal",
  "salePricePerMeter": "decimal",
  "receiverName": "string?",
  "initialCollectionAmount": "decimal?"
}
```

Server computes meters/required/remaining and the price-override status. Returns the new order with `status` reflecting `DRAFT` or `PENDING_PRICE_APPROVAL`.

`POST /orders/:id/confirm` errors:
- `409 insufficient_stock`
- `409 price_approval_required`
- `409 invalid_state_transition`

---

## Expenses

Branch-scoped.

| Method | Path                       | Roles                                 |
|--------|----------------------------|---------------------------------------|
| GET    | `/expenses?branchId=…&…`   | any authenticated for that branch      |
| POST   | `/expenses`                | OWNER, BRANCH_MANAGER, ACCOUNTANT     |

---

## Suppliers + Factory Ledger

| Method | Path                                         | Roles                              |
|--------|----------------------------------------------|------------------------------------|
| GET    | `/suppliers`                                 | any authenticated                  |
| POST   | `/suppliers`                                 | OWNER, ACCOUNTANT                  |
| PATCH  | `/suppliers/:id`                             | OWNER                              |
| GET    | `/factory-ledger?supplierId=…&…`             | OWNER, ACCOUNTANT                  |
| POST   | `/factory-ledger/entries`                    | OWNER, ACCOUNTANT                  |
| POST   | `/factory-ledger/payments`                   | OWNER, ACCOUNTANT                  |

Both write endpoints recompute the supplier's running balance inside the transaction.

---

## Reports / Dashboard

| Method | Path                              | Roles               | Notes |
|--------|-----------------------------------|---------------------|-------|
| GET    | `/reports/dashboard?branchId=…`   | any authenticated for that branch (omit for all-branches view if OWNER) | aggregates: total sales, collected, remaining, stock summary, expenses, factory balances per supplier, low-stock list |

---

## Audit

| Method | Path                                    | Roles                                  |
|--------|-----------------------------------------|----------------------------------------|
| GET    | `/audit?entityType=…&entityId=…`        | OWNER (full); BRANCH_MANAGER (their branch records only) |
| GET    | `/audit/by-actor/:userId`               | OWNER                                  |

Responses include `human_readable_summary_ar` and `human_readable_summary_en` so the UI shows the active language directly.

---

## Excel Import (one-shot migration)

OWNER only.

| Method | Path                       | Body                                |
|--------|----------------------------|-------------------------------------|
| POST   | `/import/dry-run`          | multipart `file` + `{ kind, branchId?, supplierId? }` |
| POST   | `/import/commit`           | same body or `{ importSessionId }`  |
| GET    | `/import/sessions/:id`     | dry-run report retrieval            |

`kind` is one of `orders | inventory | expenses | factory_ledger`. The dry-run returns:

```json
{
  "sessionId": "uuid",
  "rowsParsed": 0,
  "rowsValid": 0,
  "validationErrors": [{ "row": 7, "code": "missing_variant", "message_ar": "...", "message_en": "..." }],
  "missingReferences": { "skuCodes": ["X-12"], "variantSizes": ["X-12@5.25"] }
}
```

Errors:
- `400 invalid_workbook`
- `409 missing_references` (commit attempted with unresolved references)

---

## Cross-cutting response conventions

- All errors: `{ "code": "snake_case", "message_ar": "...", "message_en": "...", "details"?: {...} }`. The `code` is stable; the messages are localized.
- Pagination: cursor-based, `?cursor=…&limit=…`, response wrapper `{ "data": [...], "nextCursor": "..." | null }`.
- Idempotency: write endpoints accept an optional `Idempotency-Key` header; the API stores `(key, response)` for 24h to prevent duplicate submissions.
- Locale: API uses `Accept-Language` (`ar` or `en`) when generating localized error messages and audit summaries; defaults to `ar` when absent.
