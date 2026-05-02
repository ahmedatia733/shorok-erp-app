# Smart ERP MVP Specification

## Status
Draft v0.1 - generated from uploaded sheets and project rules.

## Source of Truth
This `spec.md` is the single source of truth. Do not implement features not defined here.

## Product Goal
Replace branch and factory Excel sheets with a production-grade smart ERP system that manages orders, inventory, expenses, factory purchases, collections, branch balances, and operational reporting.

## Default Locales
- Primary: Arabic Egypt `ar-EG`, RTL.
- Secondary: English `en`, LTR toggle.
- Code must use translation keys only. UI must display real localized text, never keys.

## Terminology Rules
- Use `Order Requests` instead of `Broadcast`.
- Use `Deliveries` instead of `Jobs`.
- Do not expose internal status keys such as `review.approved` or `prescription.broadcast`.
- Do not use healthcare terms like `Patient` / `مريض`.

## Clarifications

### Session 2026-05-02
- Q: When a user confirms a customer order but the branch's on-hand stock is insufficient, what should happen? → A: Hard-block: confirmation fails with a clear error; the user must adjust quantity or wait for a stock receipt before the order can be confirmed. Inventory must never go negative.
- Q: Should the per-order sale price be editable, fixed by product variant, or controlled? → A: Editable per order within a configured % tolerance of the variant's default sale price; outside that tolerance the order requires Owner/Admin approval before it can be confirmed.
- Q: Is the factory ledger tied to one supplier or multiple? → A: Multiple suppliers from day one; introduce a `Supplier` entity, reference `supplier_id` on each factory order/payment row, and compute the running balance per supplier.
- Q: Should inventory support transfers between branches in MVP? → A: No. Inter-branch transfers are out of MVP scope; the `transfer_in` / `transfer_out` movement types are removed from the MVP enum.
- Q: Will users sign in by email, phone, or both? → A: Phone number (with country code) is the primary login identifier; email is an optional profile field on the user record.

## Current Spreadsheet-Derived Scope
Uploaded sheets indicate the MVP should cover:

1. Branch orders
   - Example sheets: `الاوردرات` in Waraq and Sohag files.
   - Fields: date, customer name, color, code, board quantity, size, meters, meter price, required amount, collected amount, remaining amount, receiver.

2. Inventory / stock count
   - Example sheets: `الجرد اليومي`, `الجرد`, `جرد قديم`, `الوارد 27-4`.
   - Fields: color, code, size, board quantity, outgoing quantity, remaining quantity, meters.

3. Expenses
   - Example sheets: `المصروفات`, `مصروفات سوهاج`.
   - Fields: date, statement, expense amount, paid from account.

4. Factory orders / supplier ledger
   - Example sheet: `طلبيات المصنع`.
   - Fields: date, code, color, size, quantity, meters, price, total, paid, balance.

## Roles

### Owner / Admin
Can manage all branches, users, products, prices, accounts, orders, expenses, inventory, factory orders, reports, audit logs, and settings.

### Branch Manager
Can manage orders, collections, expenses, stock movements, and reports for assigned branch only.

### Warehouse User
Can manage stock receipts, stock outgoing, stock counts, and inventory adjustments for assigned branch only.

### Accountant
Can manage collections, expenses, supplier/factory payments, balances, and financial reports across allowed branches.

### Viewer
Read-only access to assigned branches and reports.

## Entities

### Branch
- id
- name_ar
- name_en
- location
- active

### User
- id
- name
- phone (with country code; primary login identifier; unique)
- email (optional profile field)
- role
- allowed_branches
- status

### Product Color / SKU
- id
- color_name_ar
- color_name_en
- code
- category: normal | special
- active

### Product Variant
- id
- sku_id
- size_meters_per_board, e.g. 4 or 5.25
- default_sale_price_per_meter
- default_purchase_price_per_meter
- price_override_tolerance_percent (nullable; falls back to a system-wide default setting)
- active

### Branch Inventory Balance
- branch_id
- product_variant_id
- boards_on_hand
- meters_on_hand
- last_counted_at

### Inventory Movement
- id
- branch_id
- product_variant_id
- movement_type: receipt | sale | adjustment | count_correction
- boards_quantity
- meters_quantity
- reference_type
- reference_id
- created_by
- created_at
- human_readable_note

### Customer Order
- id
- branch_id
- order_date
- customer_name
- product_variant_id
- boards_quantity
- meters_quantity
- sale_price_per_meter
- price_override_status: within_tolerance | pending_approval | approved
- price_approved_by_user_id (nullable)
- price_approved_at (nullable)
- required_amount
- collected_amount
- remaining_amount
- receiver_name
- status: draft | pending_price_approval | confirmed | partially_collected | paid | cancelled
- created_by
- created_at

### Expense
- id
- branch_id
- expense_date
- description
- amount
- paid_from_account
- created_by
- created_at

### Supplier
- id
- name_ar
- name_en
- active

### Factory Order / Supplier Ledger Entry
- id
- supplier_id
- order_date
- product_variant_id nullable for payment-only rows
- boards_quantity
- meters_quantity
- purchase_price_per_meter
- total_amount
- paid_amount
- running_balance (computed per supplier)
- notes
- created_by
- created_at

### Audit Log
- id
- actor_id
- action
- entity_type
- entity_id
- before_snapshot
- after_snapshot
- human_readable_summary_ar
- human_readable_summary_en
- created_at

## Core User Flows

### Sign in
1. User opens app.
2. User enters phone number (with country code) and password.
3. System signs user in and redirects to dashboard.
4. UI uses neutral copy: `Sign in`, `تسجيل الدخول`.

### Create branch order
1. Authorized user selects branch.
2. User opens Orders.
3. User clicks `Create order` / `إنشاء طلب`.
4. User selects product color/code and size.
5. User enters boards quantity and price per meter.
6. System calculates meters, required amount, remaining amount.
7. System compares the entered price per meter against the product variant's default sale price; if the deviation is within the configured tolerance, `price_override_status` is set to `within_tolerance` and the order can proceed to confirmation. If the deviation exceeds tolerance, `price_override_status` is set to `pending_approval`, the order's `status` becomes `pending_price_approval`, and an Owner/Admin must approve the override before confirmation is allowed.
8. User records collected amount and receiver.
9. On confirmation, system validates that on-hand stock for the selected branch and product variant is greater than or equal to the requested boards quantity; if insufficient, confirmation is rejected with a clear error and no movement is recorded.
10. On successful confirmation, system records inventory outgoing movement.
11. System writes audit log, including any price-override approval action.

### Record collection
1. User opens existing order.
2. User adds collected amount.
3. System recalculates remaining amount.
4. Status updates to paid or partially collected.
5. Audit log records human-readable change.

### Receive inventory
1. Warehouse user opens Inventory.
2. User selects branch and product variant.
3. User enters received boards.
4. System calculates meters.
5. Stock balance increases.
6. Audit log records receipt.

### Daily stock count
1. Warehouse user opens Inventory Count.
2. System shows current expected stock.
3. User enters counted boards per product variant.
4. System shows variance.
5. User confirms adjustment.
6. Adjustment movement and audit log are created.

### Record expense
1. User opens Expenses.
2. User enters date, description, amount, paid-from account.
3. System saves expense under selected branch.
4. Audit log records the action.

### Record factory order or payment
1. Accountant opens Factory Orders.
2. User selects the supplier.
3. User records purchase rows with product, quantity, price.
4. User records payment-only rows where applicable.
5. System calculates total and the running balance for the selected supplier.
6. Audit log records changes.

## Dashboard Requirements

Dashboard must show:
- Total sales amount by branch.
- Collected amount.
- Remaining amount.
- Current stock value/quantity summary.
- Expenses by branch.
- Factory/supplier balance, broken out per supplier.
- Low-stock alerts.

## Constraints

### Technical
- Production-grade full-stack application.
- Backend must enforce authorization; frontend-only restrictions are insufficient.
- Use relational database with transactions for financial and stock mutations.
- All money calculations must be deterministic and auditable.
- No hardcoded UI text.
- RTL/LTR supported from day one.

### Data Integrity
- Order financial totals must be derived from quantity, meters, and price.
- Inventory balances must be derived or reconciled from movements.
- Branch on-hand stock for any product variant must never be allowed to go negative; the system must reject any movement or order confirmation that would produce a negative balance.
- Deleting confirmed financial/stock records is not allowed; use cancellation/reversal entries.
- Audit logs must be append-only.

### Privacy and Safety
- No sensitive data in push notifications.
- Human-readable audit logs must be shown in UI.
- User access must be branch-scoped unless role allows broader access.

## MVP Modules

1. Authentication and role-based access.
2. Branch management.
3. Product/SKU and size management.
4. Orders and collections.
5. Inventory receipts, outgoing, balances, and counts.
6. Expenses.
7. Factory orders/payments ledger.
8. Dashboard and reports.
9. Audit logs.
10. i18n + RTL/LTR support.

## Out of Scope for MVP
- AI forecasting.
- Mobile native app.
- External accounting integrations.
- Barcode scanning.
- Offline-first mode.
- Multi-company tenancy.
- Inter-branch stock transfers.

## Non-Blocking Clarifications Needed
1. Preferred stack: Next.js/NestJS/PostgreSQL, or another stack? *(deferred to `/speckit-plan`)*

## Acceptance Criteria
- A branch user can create orders and see correct balances.
- Inventory decreases automatically for confirmed sales.
- Inventory receipts and count adjustments update branch balances.
- Expenses are branch-scoped and reportable.
- Factory purchases/payments calculate running supplier balance.
- Dashboard reflects orders, collections, remaining balances, expenses, and inventory.
- Audit logs are append-only and human-readable.
- Arabic RTL UI works by default; English LTR toggle works.
