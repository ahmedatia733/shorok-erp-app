# Reports Design Spec (Stub)

## Screen Purpose
Reach point for canned business reports — exports of orders, collections,
expenses, factory ledger, etc.

## Status
**Stub for v0.1.0-mvp.** Per `research.md` open question R-Open
("concrete report list pending feedback"), we ship the dashboard
aggregator + dashboard UI now and place a placeholder Reports page so
the sidebar entry resolves and operators can find their way back to
the dashboard.

## Layout Structure
1. Page header — title `التقارير` / `Reports`.
2. Single placeholder card: localized "coming soon" message, with a
   primary action linking to the dashboard.

## Components Used
Card, Button, Alert (info variant), localized text.

## States
Single state — explanatory placeholder. No data fetches.

## RTL/LTR Behavior
AR is RTL by default, EN flips to LTR. Identical layout in both.

## Copy
- `التقارير` / `Reports`
- `صفحة التقارير قيد الإعداد` / `Reports page is being prepared`
- `تواصل معنا لطلب تقرير محدد` / `Contact us to request a specific report`
- `الذهاب إلى لوحة التحكم` / `Go to the dashboard`

## Edge Cases
None — pure static content.

## Follow-ups (post-MVP)
- Concrete list of canned exports (PDF/XLSX) once business confirms
  which reports are needed.
- Per-report parameters (date range, branch, supplier, status filters).
- Per-role visibility (some reports OWNER-only).
