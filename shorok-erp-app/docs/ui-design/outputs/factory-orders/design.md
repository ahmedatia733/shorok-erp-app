# Factory Orders Design Spec

## Screen Purpose
Manage factory purchase rows, payment rows, and running supplier/factory balance.

## Layout Structure
1. Header: title and add entry button.
2. Summary cards: total purchases, total paid, current balance.
3. Ledger table.
4. Add purchase/payment drawer.

## Components Used
Card, Table, Button, Select, NumberInput, CurrencyInput, DatePicker, Drawer, Badge, Toast.

## States
Loading, empty, error, success.

## User Actions
Add purchase entry, add payment entry, filter ledger, view audit trail.

## RTL/LTR Behavior
Arabic RTL by default; English LTR mirrors layout. Ledger running balance remains chronological.

## Copy
- `طلبيات المصنع` / `Factory orders`
- `إضافة عملية` / `Add entry`
- `إجمالي المشتريات` / `Total purchases`
- `إجمالي المدفوع` / `Total paid`
- `الرصيد الحالي` / `Current balance`

## Edge Cases
- Payment-only rows have no product required.
- Running balance recalculates from chronological entries.
