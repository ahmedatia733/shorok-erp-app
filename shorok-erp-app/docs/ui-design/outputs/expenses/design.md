# Expenses Design Spec

## Screen Purpose
Record and review branch expenses.

## Layout Structure
1. Header with create expense button.
2. Filters: branch, date, paid-from account.
3. Expenses table.
4. Create/edit expense drawer.

## Components Used
Table, Button, Input, DatePicker, CurrencyInput, Select, Drawer, Toast.

## States
Loading, empty, error, success.

## User Actions
Create expense, edit allowed expense, view audit trail, filter expenses.

## RTL/LTR Behavior
Default RTL. Amounts aligned consistently.

## Copy
- `المصروفات` / `Expenses`
- `إضافة مصروف` / `Add expense`
- `البيان` / `Description`
- `من حساب` / `Paid from account`

## Edge Cases
- Empty description blocked.
- Zero or negative amount blocked.
