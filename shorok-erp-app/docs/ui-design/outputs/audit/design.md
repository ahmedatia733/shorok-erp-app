# Audit Log Viewer Design Spec

## Screen Purpose
A dedicated chronological viewer of the `audit_logs` table. The reusable
inline `audit-tail` component (used by every detail page) shows the audit
trail for one entity; this page lets OWNER (and BRANCH_MANAGER for their
branch's entities) browse and filter the whole append-only log.

## Layout Structure
1. Page header — title `سجل الأنشطة` / `Audit log`.
2. Filter bar — entityType (text), entityId (uuid), actor (user dropdown
   for OWNER / locked to self for BRANCH_MANAGER), from/to dates, an
   apply button. Filters survive page navigation via querystring.
3. Timeline list — newest-first cards, each showing:
   - actor name + action badge
   - localized human-readable summary in the active locale
   - relative timestamp (full ISO under it for precision, LTR-aligned
     even in AR per spec)
   - expandable "show diff" reveal that pretty-prints the
     `before_snapshot` / `after_snapshot` JSON (LTR / monospace).
4. "Load more" button driven by `nextCursor`.

## Components Used
Card, Badge, Button, Input, Label, EmptyState, Skeleton, Alert.

## States
Loading (skeleton list of 3 cards), empty, error, success.

## RBAC
- Read all: OWNER.
- Read branch-scoped: BRANCH_MANAGER (server filters to their entities;
  the actor filter is hidden because the result set is already
  branch-scoped).
- All other roles: redirect away (the sidebar entry hides for them).

## RTL/LTR Behavior
AR is RTL by default; EN flips. Timestamps and JSON snapshots remain
LTR-aligned (forced via `dir="ltr"`) inside the AR layout per
research.md guidance.

## Copy
- `سجل الأنشطة` / `Audit log`
- `نوع الكيان` / `Entity type`
- `مُعرّف الكيان` / `Entity id`
- `المستخدم` / `Actor`
- `من` / `From`
- `إلى` / `To`
- `تطبيق الفلاتر` / `Apply filters`
- `إعادة ضبط` / `Reset`
- `إظهار التفاصيل` / `Show details`
- `إخفاء التفاصيل` / `Hide details`
- `لا توجد أنشطة بعد` / `No activity yet`
- `تحميل المزيد` / `Load more`

## Edge Cases
- Same-second writes: append-only ordering uses (createdAt, id) tiebreak.
- Filter set producing no rows: shows the empty state, not an error.
- before/after JSON missing: hide the "Show details" expander entirely.
