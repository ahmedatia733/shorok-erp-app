# UI Design System Spec

## Purpose
Define the internal design system for the Smart ERP. All screen design specs and UI implementation must follow this document.

## Direction and Localization
- Default: Arabic Egypt `ar-EG`, RTL.
- Secondary: English `en`, LTR.
- Layout must mirror between RTL and LTR.
- Numbers and currency should follow selected locale formatting.
- Code uses translation keys; UI displays localized real text.

## Color Tokens
- `color.primary`: Deep teal for primary actions and active navigation.
- `color.primaryHover`: Darker teal for hover states.
- `color.background`: Off-white app background.
- `color.surface`: White cards, tables, modals.
- `color.textPrimary`: Near-black main text.
- `color.textSecondary`: Muted gray text.
- `color.border`: Light gray borders.
- `color.success`: Green for paid/success states.
- `color.warning`: Amber for partial/low-stock warnings.
- `color.danger`: Red for errors, cancellation, negative balances.
- `color.info`: Blue for neutral informational messages.

## Typography
- Arabic: system Arabic-capable font stack.
- English: system sans-serif font stack.
- Page title: 24-30px, bold.
- Section title: 18-20px, semibold.
- Body: 14-16px, regular.
- Table body: 13-14px.
- Labels: 13-14px, medium.

## Spacing Scale
- 4px: compact gaps.
- 8px: field-internal spacing.
- 12px: small component gap.
- 16px: standard spacing.
- 24px: section spacing.
- 32px: page spacing.

## Component Primitives
- Button: primary, secondary, ghost, danger.
- Input: text, number, date, currency.
- Select: searchable for products, branches, users.
- Card: dashboard and grouped forms.
- Table: sortable, filterable, paginated.
- Badge: status labels.
- Modal/Drawer: create/edit flows.
- Toast: success/error feedback.
- Empty State: clear icon/title/body/action.
- Alert: warning and validation summaries.
- Tabs: module sub-sections.
- Breadcrumb: optional for deep pages.

## Interaction Rules
- Primary action appears at page header end side.
- Destructive actions require confirmation.
- Save buttons disabled while submitting.
- Forms show inline validation and summary for submit failures.
- Tables preserve filters during navigation where possible.
- Financial and inventory mutations show confirmation where risk is high.

## Accessibility Rules
- Keyboard navigation required.
- Visible focus states required.
- Minimum contrast ratio 4.5:1 for text.
- Form labels must be associated with inputs.
- Error messages must be readable by screen readers.
- Do not rely on color only for status.

## Copy Rules
- Use human-friendly business language.
- Do not expose internal keys.
- Do not use `Patient` / `مريض`.
- Arabic examples:
  - `إنشاء طلب`
  - `رصيد المخزون`
  - `المبلغ المتبقي`
  - `تم حفظ التغييرات`
- English examples:
  - `Create order`
  - `Inventory balance`
  - `Remaining amount`
  - `Changes saved`
