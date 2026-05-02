# Data Model: Shorok ERP MVP — Phase 1

This file is the authoritative data model for the MVP, derived from `spec.md` (entities, clarifications) and the decisions in `research.md` (transactional engine, money types, audit semantics, order state machine, pricing approval).

All money columns are `NUMERIC(14,2)` (Prisma `Decimal`), currency `EGP`. Times are `TIMESTAMPTZ`. Soft deletes are not used; deletes of confirmed financial/stock records are forbidden — use cancellation/reversal entries (see Order state machine).

---

## Enums

```text
Role             = OWNER | BRANCH_MANAGER | WAREHOUSE | ACCOUNTANT | VIEWER
UserStatus       = ACTIVE | DISABLED
ProductCategory  = NORMAL | SPECIAL
MovementType     = RECEIPT | SALE | ADJUSTMENT | COUNT_CORRECTION
OrderStatus      = DRAFT | PENDING_PRICE_APPROVAL | CONFIRMED | PARTIALLY_COLLECTED | PAID | CANCELLED
PriceOverrideStatus = WITHIN_TOLERANCE | PENDING_APPROVAL | APPROVED
AuditAction      = CREATE | UPDATE | CONFIRM | CANCEL | APPROVE | COLLECT | IMPORT | LOGIN | LOGOUT
```

`MovementType` deliberately excludes `TRANSFER_IN`/`TRANSFER_OUT` per the clarify session (inter-branch transfers are out of MVP).

---

## Entities

### Branch

| Field      | Type            | Notes |
|------------|-----------------|-------|
| id         | uuid PK         | |
| name_ar    | varchar(120)    | required |
| name_en    | varchar(120)    | required |
| location   | varchar(240)    | optional |
| active     | boolean         | default `true` |
| created_at | timestamptz     | |
| updated_at | timestamptz     | |

Indexes: unique `(name_ar)`, unique `(name_en)`.

---

### User

| Field             | Type            | Notes |
|-------------------|-----------------|-------|
| id                | uuid PK         | |
| name              | varchar(120)    | required |
| phone             | varchar(20)     | E.164, **unique**, primary login identifier |
| email             | varchar(160)    | optional, unique when present |
| password_hash     | varchar(120)    | bcrypt, never returned by API |
| role              | Role            | required |
| status            | UserStatus      | default `ACTIVE` |
| last_login_at     | timestamptz     | nullable |
| created_at        | timestamptz     | |
| updated_at        | timestamptz     | |

**UserBranchAccess** (many-to-many between User and Branch):

| Field      | Type      | Notes |
|------------|-----------|-------|
| user_id    | uuid FK   | composite PK |
| branch_id  | uuid FK   | composite PK |
| created_at | timestamptz | |

`OWNER` users implicitly have access to all branches and may have zero `UserBranchAccess` rows.

---

### RefreshToken

| Field       | Type         | Notes |
|-------------|--------------|-------|
| id          | uuid PK      | |
| user_id     | uuid FK      | indexed |
| token_hash  | varchar(120) | sha256 hex of opaque random token |
| expires_at  | timestamptz  | |
| revoked_at  | timestamptz  | nullable |
| created_at  | timestamptz  | |
| user_agent  | varchar(240) | optional |

Index: unique `(token_hash)`.

---

### ProductSku

| Field          | Type            | Notes |
|----------------|-----------------|-------|
| id             | uuid PK         | |
| code           | varchar(60)     | **unique** |
| color_name_ar  | varchar(120)    | required |
| color_name_en  | varchar(120)    | required |
| category       | ProductCategory | default `NORMAL` |
| active         | boolean         | default `true` |
| created_at     | timestamptz     | |
| updated_at     | timestamptz     | |

---

### ProductVariant

| Field                            | Type           | Notes |
|----------------------------------|----------------|-------|
| id                               | uuid PK        | |
| sku_id                           | uuid FK        | indexed |
| size_meters_per_board            | numeric(10,4)  | e.g., `4` or `5.25`; must be `> 0` |
| default_sale_price_per_meter     | numeric(14,2)  | required, must be `> 0` |
| default_purchase_price_per_meter | numeric(14,2)  | required, must be `> 0` |
| price_override_tolerance_percent | numeric(5,2)   | nullable; falls back to `system_settings.default_price_override_tolerance_percent` |
| active                           | boolean        | default `true` |
| created_at                       | timestamptz    | |
| updated_at                       | timestamptz    | |

Indexes: unique `(sku_id, size_meters_per_board)`.

---

### Supplier

| Field    | Type         | Notes |
|----------|--------------|-------|
| id       | uuid PK      | |
| name_ar  | varchar(160) | required |
| name_en  | varchar(160) | required |
| active   | boolean      | default `true` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

Indexes: unique `(name_ar)`, unique `(name_en)`.

---

### BranchInventoryBalance

| Field              | Type           | Notes |
|--------------------|----------------|-------|
| branch_id          | uuid FK        | composite PK part 1 |
| product_variant_id | uuid FK        | composite PK part 2 |
| boards_on_hand     | numeric(14,4)  | **CHECK ≥ 0** |
| meters_on_hand     | numeric(14,4)  | **CHECK ≥ 0** |
| last_counted_at    | timestamptz    | nullable |
| updated_at         | timestamptz    | |

Indexes: composite PK is the natural index. `meters_on_hand` is derived (`boards_on_hand × variant.size_meters_per_board`) but stored for fast reads; the engine writes both atomically.

---

### InventoryMovement

| Field                | Type           | Notes |
|----------------------|----------------|-------|
| id                   | uuid PK        | |
| branch_id            | uuid FK        | indexed |
| product_variant_id   | uuid FK        | indexed |
| movement_type        | MovementType   | |
| boards_quantity      | numeric(14,4)  | signed: positive for stock in, negative for stock out |
| meters_quantity      | numeric(14,4)  | signed; same sign convention as boards |
| reference_type       | varchar(40)    | e.g., `customer_order`, `import`, `count` |
| reference_id         | uuid           | nullable |
| created_by           | uuid FK → User | |
| created_at           | timestamptz    | |
| human_readable_note  | text           | optional, may include language-tagged segments (`ar:` / `en:`) |

Append-only. No `UPDATE`/`DELETE` privileges in production.

Indexes: `(branch_id, product_variant_id, created_at desc)` for ledger reads.

---

### CustomerOrder

| Field                       | Type                | Notes |
|-----------------------------|---------------------|-------|
| id                          | uuid PK             | |
| branch_id                   | uuid FK             | indexed |
| order_date                  | date                | required, default current date |
| customer_name               | varchar(160)        | free text in MVP (Customer entity deferred) |
| product_variant_id          | uuid FK             | required |
| boards_quantity             | numeric(14,4)       | must be `> 0` |
| meters_quantity             | numeric(14,4)       | derived = `boards_quantity × size_meters_per_board` |
| sale_price_per_meter        | numeric(14,2)       | must be `> 0` |
| price_override_status       | PriceOverrideStatus | default `WITHIN_TOLERANCE` |
| price_approved_by_user_id   | uuid FK → User      | nullable |
| price_approved_at           | timestamptz         | nullable |
| required_amount             | numeric(14,2)       | derived = `meters_quantity × sale_price_per_meter` |
| collected_amount            | numeric(14,2)       | default `0`; sum of OrderCollection rows |
| remaining_amount            | numeric(14,2)       | derived = `required_amount - collected_amount` |
| receiver_name               | varchar(160)        | optional |
| status                      | OrderStatus         | default `DRAFT` |
| created_by                  | uuid FK → User      | |
| created_at                  | timestamptz         | |
| updated_at                  | timestamptz         | |

Indexes: `(branch_id, order_date desc)`, `(status)`, `(price_override_status) where status = 'PENDING_PRICE_APPROVAL'`.

**Derived field rules**: `meters_quantity`, `required_amount`, `remaining_amount` are computed by the API on every write. They are stored for reporting performance; a periodic reconciliation job (post-MVP) verifies them.

**State machine (allowed transitions)**:

```text
DRAFT → PENDING_PRICE_APPROVAL    (price outside tolerance)
DRAFT → CONFIRMED                 (price within tolerance, on confirmation)
PENDING_PRICE_APPROVAL → CONFIRMED (after approve + confirm)
PENDING_PRICE_APPROVAL → CANCELLED
CONFIRMED → PARTIALLY_COLLECTED   (first non-zero, non-full collection)
CONFIRMED → PAID                  (collection covers required_amount)
PARTIALLY_COLLECTED → PAID
CONFIRMED → CANCELLED             (creates reversal SALE inventory movement)
PARTIALLY_COLLECTED → CANCELLED   (Owner/Admin only; creates reversal + refund OrderCollection)
PAID → CANCELLED                  (Owner/Admin only; creates reversal + refund OrderCollection)
CANCELLED                          (terminal)
```

---

### OrderCollection

| Field           | Type           | Notes |
|-----------------|----------------|-------|
| id              | uuid PK        | |
| order_id        | uuid FK        | indexed |
| collected_at    | timestamptz    | default now |
| amount          | numeric(14,2)  | `> 0` for collections, `< 0` for refunds; CHECK `amount != 0` |
| paid_to_account | varchar(120)   | nullable, e.g., "cash", "vodafone-cash", "branch-safe" |
| created_by      | uuid FK → User | |
| created_at      | timestamptz    | |

Append-only. Confirmed-amount enforcement: at insert time, the collection cannot make `collected_amount` exceed `required_amount` for non-cancelled orders (HTTP 409).

---

### Expense

| Field            | Type           | Notes |
|------------------|----------------|-------|
| id               | uuid PK        | |
| branch_id        | uuid FK        | indexed |
| expense_date     | date           | required |
| description      | varchar(240)   | required |
| amount           | numeric(14,2)  | `> 0` |
| paid_from_account| varchar(120)   | required (e.g., "cash", "branch-safe") |
| created_by       | uuid FK → User | |
| created_at       | timestamptz    | |

Append-only beyond corrections (corrections are new compensating expense rows with negative amount or a separate "reversal" mechanism — to be resolved during tasks; for MVP, only Owner/Admin may post negative amounts as adjustments).

---

### FactoryLedgerEntry

| Field                    | Type           | Notes |
|--------------------------|----------------|-------|
| id                       | uuid PK        | |
| supplier_id              | uuid FK        | indexed |
| order_date               | date           | |
| product_variant_id       | uuid FK        | nullable for payment-only rows |
| boards_quantity          | numeric(14,4)  | nullable |
| meters_quantity          | numeric(14,4)  | nullable; derived when present |
| purchase_price_per_meter | numeric(14,2)  | nullable |
| total_amount             | numeric(14,2)  | derived for purchase rows; `0` for payment-only rows |
| paid_amount              | numeric(14,2)  | `>= 0` |
| running_balance          | numeric(14,2)  | computed per supplier in chronological order; persisted for fast reads |
| notes                    | text           | optional |
| created_by               | uuid FK → User | |
| created_at               | timestamptz    | |

Append-only. The `running_balance` is recalculated whenever a row's `order_date` lands earlier than existing rows for the same supplier (rare); a guarded SQL function performs the recompute inside the transaction.

Indexes: `(supplier_id, order_date)`.

---

### AuditLog

| Field                    | Type           | Notes |
|--------------------------|----------------|-------|
| id                       | uuid PK        | |
| actor_id                 | uuid FK → User | nullable for system events (e.g., import) |
| action                   | AuditAction    | |
| entity_type              | varchar(60)    | e.g., `customer_order`, `inventory_movement` |
| entity_id                | uuid           | nullable for cross-entity actions |
| before_snapshot          | jsonb          | nullable |
| after_snapshot           | jsonb          | nullable |
| human_readable_summary_ar| text           | required |
| human_readable_summary_en| text           | required |
| created_at               | timestamptz    | |

Append-only at the DB level (REVOKE UPDATE, DELETE on `audit_logs`). The API never exposes mutations.

Indexes: `(entity_type, entity_id, created_at desc)`, `(actor_id, created_at desc)`.

---

### SystemSettings

Single-row table.

| Field                                       | Type           | Notes |
|---------------------------------------------|----------------|-------|
| id                                          | smallint PK    | always `1`; CHECK constraint enforces single row |
| default_price_override_tolerance_percent    | numeric(5,2)   | default `5.00` |
| low_stock_threshold_boards                  | numeric(14,4)  | dashboard low-stock alert threshold; default `5` |
| created_at                                  | timestamptz    | |
| updated_at                                  | timestamptz    | |

---

## Cross-cutting integrity rules

1. **Non-negative inventory** — `BranchInventoryBalance` `boards_on_hand` and `meters_on_hand` have a CHECK constraint and are written only by `InventoryEngine` inside a Postgres transaction with `FOR UPDATE` row lock.

2. **Append-only tables** — `inventory_movements`, `order_collections`, `audit_logs`, `factory_ledger_entries`. Production DB role lacks UPDATE/DELETE on these tables; corrections are new rows.

3. **Role of OWNER** — implicit access to all branches; bypasses `BranchScopeGuard`.

4. **Branch scoping** — every endpoint that reads or mutates branch-scoped data accepts a `branchId` and is intercepted by `BranchScopeGuard`, which 403s when the user has no matching `UserBranchAccess` (and is not OWNER).

5. **Audit-log atomicity** — `AuditService.write` is called inside the same Prisma transaction as the action it describes; failure to write the audit row aborts the action.

6. **Currency** — single currency `EGP` in MVP; no `currency_code` column on financial rows.

---

## ERD (textual)

```text
Branch ─┬────< UserBranchAccess >────┬─ User
        │                             ├──< RefreshToken
        │                             └──< [created_by on most tables]
        │
        ├────< BranchInventoryBalance >── ProductVariant ──> ProductSku
        │                              \── (price_override_tolerance_percent overrides SystemSettings.default…)
        │
        ├────< InventoryMovement >── ProductVariant
        │
        ├────< CustomerOrder >── ProductVariant
        │           └────< OrderCollection
        │
        └────< Expense

Supplier ────< FactoryLedgerEntry >── ProductVariant (nullable)

AuditLog ── (actor_id) ── User
SystemSettings (singleton)
```
