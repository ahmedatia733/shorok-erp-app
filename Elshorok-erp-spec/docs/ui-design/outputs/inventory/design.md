# Inventory Design Spec

## Screen Purpose
Manage branch inventory balances, receipts, outgoing movements, and daily stock counts.

## Layout Structure
1. Header and branch filter.
2. Inventory balance table grouped by color/code/size.
3. Actions: receive stock, count stock, adjust stock.
4. Movement history table.

## Components Used
Table, Button, Select, NumberInput, Drawer, Modal, Badge, Alert, EmptyState.

## States
Loading, empty, error, success, low-stock warning.

## User Actions
Receive stock, record stock count, view movement history, open movement details.

## RTL/LTR Behavior
Tables mirror column order by locale, but code and numeric values remain readable.

## Copy
- `رصيد المخزون` / `Inventory balance`
- `استلام مخزون` / `Receive stock`
- `جرد المخزون` / `Stock count`
- `الحركة` / `Movement`

## Edge Cases
- Count variance requires confirmation.
- Negative stock not allowed unless future admin override is specified.
