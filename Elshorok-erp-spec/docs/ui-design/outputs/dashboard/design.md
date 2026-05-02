# Dashboard Design Spec

## Screen Purpose
Give owners and branch users a fast operational overview of sales, collections, remaining balances, expenses, inventory, and factory balance.

## Layout Structure
1. Page header: title, branch filter, date range filter, language toggle.
2. KPI cards: sales, collected, remaining, expenses, factory balance.
3. Alert section: low stock and overdue remaining amounts.
4. Charts section: branch sales and expense summary.
5. Recent activity: latest orders, expenses, inventory movements.

## Components Used
Card, Select, DateRangePicker, Badge, Table, Button, Alert, Skeleton, EmptyState.

## States
- Loading: skeleton KPI cards and tables.
- Empty: `لا توجد بيانات لهذا النطاق الزمني` / `No data for this period`.
- Error: `تعذر تحميل لوحة التحكم` / `Could not load dashboard`.
- Success: dashboard data visible.

## User Actions
- Change branch filter.
- Change date range.
- Open low-stock item.
- Open recent order/expense/movement.

## RTL/LTR Behavior
RTL by default. KPI order mirrors in English LTR.

## Copy
Arabic title: `لوحة التحكم`.
English title: `Dashboard`.

## Edge Cases
- User has access to one branch only: hide branch dropdown and show branch name.
- Negative balance: show danger status with readable explanation.
