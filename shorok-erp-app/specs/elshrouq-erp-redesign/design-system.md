# Elshrouq ERP — Design System Specification

**Feature**: elshrouq-erp-redesign · Arabic-first RTL · brandable per Constitution VIII

## H. Design System Specification

Evolves the existing Tailwind token approach (keep class names; move values to CSS variables so branding is per-company config).

### H.1 Color tokens (CSS variables, brandable)

| Token | Default (light) | Dark | Usage |
|---|---|---|---|
| `--brand-primary` | `#0F766E` teal (current, keep) | `#2DD4BF` | Actions, active nav, links — **per-company override** |
| `--brand-primary-hover` | `#115E59` | `#5EEAD4` | |
| `--bg` | `#F7F8FA` | `#0F1620` | App background |
| `--surface` | `#FFFFFF` | `#1A2432` | Cards, tables, modals |
| `--surface-raised` | `#F1F4F8` | `#233042` | Table headers, wells |
| `--text-1` / `--text-2` / `--text-3` | `#101828` / `#475467` / `#98A2B3` | `#F2F4F7`/`#94A3B8`/`#64748B` | Hierarchy |
| `--border` | `#E4E7EC` | `#2A3648` | |
| Semantic (NOT brandable): `--ok` `#067647`/bg `#ECFDF3` · `--warn` `#B54708`/bg `#FFFAEB` · `--danger` `#B42318`/bg `#FEF3F2` · `--info` `#175CD3`/bg `#EFF8FF` | | | Status only — never decorative |

Document status colors: مسودة = neutral gray badge · مُرحّل = ok green · ملغي بقيد عكسي = danger red outline · فترة مقفلة = lock icon + neutral. Debit column accent `--ok`, credit column accent `--danger` — used consistently in every journal/statement table.

Dark mode: **yes, ship it** — token-level only (`:root[data-theme]` + `prefers-color-scheme`), zero component-level color literals. Accountants work long hours; it's cheap once tokens are disciplined.

### H.2 Typography

- **Face:** IBM Plex Sans Arabic (self-hosted woff2 — no CDN) for UI + Latin companion IBM Plex Sans; fallback `"Segoe UI", Tahoma`. Professional, excellent Arabic/Latin harmony, free license. (Cairo = acceptable alternative if client prefers rounder look.)
- **Numerals:** Western digits (0-9) everywhere — Egyptian accounting standard; `font-variant-numeric: tabular-nums` mandatory on every numeric column, total, and KPI.
- Scale: 12 caption · 13 table-body · 14 body/forms · 16 section titles · 20 page titles · 28 KPI figures. Weights 400/600/700 only. Money always 2dp, thousands separator `1,234,567.89`, currency as trailing "ج.م" (or code EGP in EN locale), negative in parentheses accounting-style `(1,500.00)` in reports.

### H.3 Spacing, layout, RTL rules

- 4px base grid; component paddings 12/16/24; page gutter 24; card radius 10px; **one radius, one shadow level** (subtle `0 1px 2px rgba(16,24,40,.06)`) — no stacked shadows.
- **Logical properties only** (`ms-/me-/ps-/pe-/start-/end-`) — existing lint rule stays and is a build error.
- RTL specifics: tables read start→end (بيان before amounts); numeric cells `dir="ltr"` internally, end-aligned; icons with direction (arrows, chevrons) auto-flip; date format `DD/MM/YYYY`; form labels above fields (not inline) for AR/EN parity.

### H.4 Components

- **Buttons:** primary (brand bg) / secondary (outline) / ghost / danger. Heights 36 (dense contexts 32). Verb-exact labels: ترحيل، حفظ مسودة، طباعة — never "موافق".
- **Cards:** header (title + optional actions) / body / footer; no nested cards.
- **Forms:** label-top, 8px gap, required = «*» + color; inline validation on blur; comboboxes (search-first) for any list > 7 items — the pattern for customers, items, accounts.
- **Tables:** `--surface-raised` sticky header; row hover; 13px body; numeric columns end-aligned tabular; status badge column standard width; footer totals row bold with top border `2px`.
- **Report tables:** add: opening-balance row styled distinct (italic + raised bg), running-balance column, subtotal group rows, print-safe (no hover-only info).
- **Badges:** pill, 11px/600, bg from semantic bg-tokens + colored text; document statuses per H.1.
- **Modals:** sizes S(400) M(640) L(920 — posting preview, allocations); title + body + end-aligned action bar (primary at start side in RTL).
- **Posting preview** (G.20) is a first-class component with fixed anatomy: entries list → inventory effects → balance check chip → confirm bar.

### H.5 Print/PDF templates

A4 for invoices & reports, A5 landscape option for vouchers. Anatomy: company header (logo from `Company`, name, tax reg no) · document title AR (+EN subtitle) · metadata grid (number/date/party/warehouse) · lines table (borders on, no fills) · totals block · amount-in-words line (تفقيط) for vouchers · signature slots (المحاسب / المستلم / المدير) · footer (page x/y, printed-at timestamp, "طُبع من نظام …" configurable). Monochrome-safe: status conveyed by text, not color.

### H.6 Company branding variables

`Company` row drives: `logo_url`, `--brand-primary` (+auto-derived hover/soft tints via color-mix), invoice header block, report footers, app title + favicon, default locale. **Rule: no brand value may appear as a literal in code — token or DB config only.** "شروق · Shorok" hardcode in the layout is removed in Phase 6.

---

## I. Claude Design / UI-Generation Prompts

Prepend this **base context block** to every prompt below:

> *"Arabic-first RTL ERP for Egyptian SMEs. Design tokens: brand primary #0F766E teal (brandable variable), bg #F7F8FA, surface #FFFFFF, text #101828/#475467, border #E4E7EC, semantic ok #067647 / warn #B54708 / danger #B42318. Font IBM Plex Sans Arabic; Western digits, tabular numerals, money 2dp + 'ج.م'. 4px grid, 10px radius, single subtle shadow. Debit=green accent, credit=red accent in all accounting tables. Status badges: مسودة gray, مُرحّل green, ملغي بقيد عكسي red-outline. Clean professional accounting product — not a generic admin template, no decorative charts, no emoji icons."*

1. **Dashboard:** "Design the RTL dashboard: sidebar per IA (list sections), 4 KPI tiles (مبيعات الشهر، مجمل الربح، النقدية، مستحق من العملاء) with tabular numbers and click-through affordance, 30-day sales sparkline, aging mini-bars, آخر المستندات list with status badges, and an alerts strip (unposted drafts, closed-period pending). Owner role view."
2. **Sales invoice:** "Design the RTL sales invoice document page: header (customer search-combobox showing live balance chip, warehouse select, date), lines table (item combobox, qty+UoM, live stock-availability chip green/amber/red, unit price, VAT toggle, line total), totals footer (subtotal, ضريبة 14%, الإجمالي) plus live margin preview, action bar حفظ مسودة/ترحيل/طباعة, DRAFT status badge. Include the stock-insufficient inline error state on one line."
3. **Purchase invoice:** "Same anatomy as sales invoice for المشتريات: supplier header, unit-cost column, and a post-success side panel noting avg-cost updates per item ('متوسط التكلفة تحدّث من ٥٥٠ إلى ٥٦٢')."
4. **Posting preview modal:** "Design the معاينة القيد قبل الترحيل modal (L size): grouped journal entries with مدين/دائن rows (green/red accents, tabular amounts), inventory-effect list (warehouse, qty delta, resulting stock), balance-check chip '✓ متوازن', cancel + تأكيد الترحيل bar."
5. **Receipt voucher:** "Design سند قبض page: two columns — voucher form (customer combobox with balance, amount, treasury select خزينة/بنوك, date, cheque ref, memo) and an allocation panel listing open invoices with auto-FIFO editable amounts and an 'على الحساب' remainder row; posting preview trigger; printed-voucher preview thumbnail."
6. **Payment voucher:** "Mirror of receipt voucher for سند صرف to a supplier."
7. **Customer statement:** "Design كشف حساب عميل: party header card (balance, aging chips 30/60/90+), date filters, statement table with رصيد افتتاحي first row, مدين/دائن columns, running الرصيد column, closing footer; print + سند قبض shortcut actions."
8. **Supplier statement:** "Mirror for مورد with سند صرف shortcut."
9. **Expenses:** "Design المصروفات: list with category chips + quick-create side sheet (نوع المصروف select, amount, خاضع للضريبة toggle, طريقة الدفع خزينة/بنك/على حساب مورد, date, البيان). Include categories-management settings tab where each category maps to a GL account."
10. **Inventory balance:** "Design أرصدة المخازن: warehouse selector, stock table (الصنف، الكمية، متوسط التكلفة، القيمة، آخر حركة), footer total with GL-reconciliation chip 'مطابق لحساب المخزون ✓', low-stock filter, drill-down to item movement history."
11. **General ledger report:** "Design دفتر الأستاذ العام report shell: filter bar (account/party/treasury picker + date range), opening balance row, ledger table with running balance, every row linking to a قيد, summary tiles (opening, Σمدين, Σدائن, closing), print/export."
12. **P&L:** "Design قائمة الدخل as a financial statement (not a grid): المبيعات → تكلفة البضاعة المباعة → مجمل الربح → مصروفات by category (expandable) → صافي الربح emphasized row; optional comparison column; date range; drill-down affordance on every figure."
13. **VAT report:** "Design تقرير ضريبة القيمة المضافة: filing-period picker, three tiles (ضريبة المبيعات، ضريبة المشتريات، صافي المستحق), detail tabs for sales/purchase/expense lines, print layout usable as tax-return worksheet."
14. **Chart of accounts:** "Design دليل الحسابات: tree view with type-colored level indicators, leaf/parent distinction, protected system-role accounts marked with lock badge, search, add-account modal with parent select and type inheritance."
15. **Journal list + manual entry:** "Design القيود اليومية: list (number, date, type badge, source-document badge with link, Σ amount, status) + manual journal entry form with balanced-indicator footer (Σمدين vs Σدائن live), party-dimension picker appearing only on control accounts."
16. **Settings — posting configuration:** "Design إعدادات الترحيل: purpose→account mapping form (default AR, AP, revenue, COGS, inventory, VAT in/out, discount, rounding), OWNER-only warning banner, versions timeline showing effective-from dates, effective-date picker in the save flow, and a change-log tab."
16b. **Settings shell + company profile:** "Design the Settings module shell: two-level settings sidebar (15 items per G.16), settings search, and the بيانات الشركة screen with logo upload showing live sidebar preview, brand-color picker updating component samples, locked currency field with tooltip, fiscal-year start, print footer."
16c. **Setup wizard:** "Design the 10-step new-company setup wizard (stepper shell reusing settings screens): company → branches/warehouses → COA template pick → posting map confirm → tax → banks/vaults → users → items import → parties import → opening balances with live trial-balance check gate (must balance to finish)."
16d. **Document numbering + print templates:** "Design تسلسل أرقام المستندات (per-document series editor with live preview chip 'PI-2026-00042') and قوالب الطباعة (field toggles, footer text, signature slots, paper size, branding policy الحالي/كما طُبع, live A4 preview pane)."
17. **Periods:** "Design الفترات المحاسبية: year grid of months with OPEN/CLOSED states, close-period flow showing pre-close checklist (unposted drafts count, reconciliation status), reopen with mandatory reason (OWNER)."
18. **Empty & error states sheet:** "Design a states sheet: list empty-state (icon + sentence + CTA), report no-data state, posting-blocked modal listing reasons with fix links, closed-period inline banner, stock-insufficient field error, reverse-confirmation dialog with consequence text and reason field."
19. **Print templates:** "Design A4 print templates for فاتورة مبيعات and A5-landscape سند قبض: company header with logo variable, metadata grid, bordered lines table, totals block, amount-in-words line, signature slots, monochrome-safe."
20. **Login + first-run:** "Design phone-number login (Egypt E.164) and the first-run company setup wizard applying branding (logo upload with live sidebar preview, primary color pick)."

---

*End of UI/UX & design-system specification.*
