# Settings Design Spec

## Screen Purpose
Single OWNER-facing area for managing all admin domains: branches, users,
products (SKUs + variants), suppliers (delegated to the existing
`/suppliers` route), system settings, and the Excel import wizard.
Every section talks to APIs that already exist in Foundational
(branches, users, products, system-settings) plus the suppliers and
import endpoints.

## Layout Structure
1. Sub-navigation (vertical or horizontal tabs):
   - Users
   - Branches
   - Products
   - Suppliers (deep-link to `/<locale>/suppliers`)
   - System settings
   - **Import** (deferred — see Phase 9 / US7)
2. Content area: list/detail patterns per section, identical to the
   patterns used in `/orders`, `/inventory`, `/expenses` (Card → Table
   → row action; create form on a dedicated route).

## Components Used
Card, Table, Button, Input, Label, Badge, Alert, Skeleton, EmptyState.

## Routes
- `/<locale>/settings`               — landing (redirects to first
                                       sub-page)
- `/<locale>/settings/users`         — users list + create/edit
- `/<locale>/settings/branches`      — branches list + create/edit
- `/<locale>/settings/products`      — SKU list + nested variants
- `/<locale>/settings/suppliers`     — alias / link to `/suppliers`
- `/<locale>/settings/system`        — system settings form
- `/<locale>/settings/import`        — Phase 9 / US7

## RBAC
The whole `/settings` tree is OWNER only. The sidebar entry hides for
other roles, and each settings sub-page guards on `useHasRole()` when
the underlying API is OWNER-restricted.

## States
Loading (skeleton list), empty, error, success (green alert after a
mutation; the form auto-redirects or stays on screen depending on the
sub-page).

## RTL/LTR Behavior
AR is RTL by default; EN flips. Phone numbers and UUIDs always render
LTR via `dir="ltr"` even in AR.

## Copy
- `الإعدادات` / `Settings`
- `المستخدمون` / `Users`
- `الفروع` / `Branches`
- `المنتجات` / `Products`
- `الموردون` / `Suppliers`
- `الإعدادات العامة` / `System settings`
- `الاستيراد` / `Import`
- per-form copy lives in the section-specific i18n keys.

## Edge Cases
- Phone normalization: forms accept E.164 only; the API normalizes
  Egyptian numbers via libphonenumber-js. Leading-zero digits are
  rejected with a localized error.
- Disabling a user that has active sessions: API revokes refresh
  tokens, the next /auth/me returns user_disabled, the web client
  catches it and forces logout.
- Deactivating a branch that has data: branch stays visible (archived
  badge) but cannot accept new writes.

## Follow-ups (post-MVP)
- Bulk operations (mass user disable, mass branch deactivation).
- Audit row link from each settings detail page to the audit viewer
  filtered by that entity.
- Settings/import sub-page lands with Phase 9.
