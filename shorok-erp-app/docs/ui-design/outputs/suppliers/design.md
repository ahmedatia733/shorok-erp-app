# Suppliers Design Spec

## Screen Purpose
Maintain the master list of factory suppliers used by the Factory Ledger
(`/factory-orders`). Suppliers are referenced by every purchase and
payment row, so this page is a hard prerequisite for the ledger UI.

## Layout Structure
1. Page header — title "الموردون / Suppliers" and an "Add supplier"
   primary button (visible to OWNER and ACCOUNTANT only).
2. List card containing a table:
   - Name (Arabic, bold)
   - Name (English, secondary text)
   - Status pill (`نشط / Active` or `موقوف / Archived`)
   - Row action: "Edit" (OWNER only).
3. Create/Edit form rendered as a card (no modal/drawer for MVP — keep the
   route stack flat to match the rest of the app). The same form template
   is reused for both create and update.
4. Empty state: "لا يوجد موردون بعد / No suppliers yet" with a CTA to add
   the first one.

## Components Used
Card, CardHeader, CardBody, Table, Button, Input, Label, Badge/Status pill,
Alert (success and error variants).

## Routes
- `/<locale>/suppliers`              — list
- `/<locale>/suppliers/new`          — create form (OWNER, ACCOUNTANT)
- `/<locale>/suppliers/[id]`         — edit form (OWNER)

## States
Loading (table skeleton or simple "loading…" text), empty, error, success
(green alert after create/update; the form auto-redirects to the list
after ~600 ms, matching expenses/inventory patterns).

## RBAC
- Read (`GET /suppliers`): any authenticated user.
- Create (`POST /suppliers`): OWNER, ACCOUNTANT — primary "Add" button
  hidden for other roles.
- Update (`PATCH /suppliers/:id`): OWNER only — "Edit" link rendered
  only for OWNER.

## RTL/LTR Behavior
AR is RTL and the default. EN flips to LTR. Names are language-specific
(`name_ar`, `name_en`) per the Supplier model. Both names are required at
create time (the API enforces uniqueness on each).

## Copy
- `الموردون` / `Suppliers`
- `إضافة مورد` / `Add supplier`
- `تعديل` / `Edit`
- `الاسم بالعربية` / `Name (Arabic)`
- `الاسم بالإنجليزية` / `Name (English)`
- `الحالة` / `Status`
- `نشط` / `Active`
- `موقوف` / `Archived`
- `حفظ` / `Save`
- `جارٍ الحفظ…` / `Saving…`
- `تم إنشاء المورد.` / `Supplier created.`
- `تم تحديث المورد.` / `Supplier updated.`
- `لا يوجد موردون بعد.` / `No suppliers yet.`

## Edge Cases
- Duplicate Arabic or English name → API returns 409 with localized
  message; surface inline as the form's error alert.
- Archived (`active: false`) suppliers stay visible in the list with the
  "Archived" badge, but cannot receive new ledger entries (the API
  rejects writes with `validation_failed { reason: "supplier_inactive" }`).
- No delete: archive (`PATCH active=false`) is the deletion analogue.
