# Orders Design Spec

## Screen Purpose
Create, view, filter, and update branch customer orders and collections.

## Layout Structure
1. Header: `الطلبات` / `Orders`, create button.
2. Filters: branch, date, customer, status, product code.
3. Orders table.
4. Create/edit order drawer.
5. Collection modal.

## Components Used
Table, Button, Input, Select, DatePicker, CurrencyInput, NumberInput, Drawer, Modal, Badge, Toast.

## States
- Loading: table skeleton.
- Empty: `لا توجد طلبات بعد` / `No orders yet`.
- Error: `تعذر تحميل الطلبات` / `Could not load orders`.
- Success: order table visible.

## User Actions
Create order, edit draft, confirm order, add collection, cancel order, export report.

## RTL/LTR Behavior
Arabic form labels align right; English align left. Numeric columns remain visually clear and aligned by decimal.

## Copy
- `إنشاء طلب` / `Create order`
- `اسم العميل` / `Customer name`
- `المبلغ المطلوب` / `Required amount`
- `المبلغ المحصل` / `Collected amount`
- `المبلغ المتبقي` / `Remaining amount`

## Edge Cases
- Collected amount exceeds required amount: block submission.
- Insufficient stock: show warning and block confirmation unless admin override is specified in future spec.
