# Elshrouq ERP — UI/UX Specification

**Status:** DRAFT awaiting approval · Arabic-first RTL, English secondary · All labels from the ratified glossary

---

## G. UI/UX Redesign Specification

### G.1 Information architecture & sidebar

```
🏠 الرئيسية (Dashboard)
🧾 المبيعات        فواتير المبيعات · مرتجعات (v1.x) · العملاء
📦 المشتريات       فواتير المشتريات · مرتجعات (v1.x) · الموردون
🏦 الخزينة والبنوك  سندات القبض · سندات الصرف · حسابات الخزينة والبنوك
💸 المصروفات       المصروفات · أنواع المصروفات
🏬 المخازن         أرصدة المخازن · حركة المخزون · الجرد · التسويات
📚 الحسابات        دليل الحسابات · القيود اليومية · قوالب القيود · الأصول الثابتة · الفترات المحاسبية
📊 التقارير        (see G.14–G.16 list)
⚙️ الإعدادات       بيانات الشركة · المستخدمون والصلاحيات · إعدادات الترحيل · الضرائب · الأصناف · المخازن والفروع
```
Sidebar sections collapse; visible items filtered by role (SALES never sees الحسابات/التقارير المالية). Active item highlighted with start-side accent bar (logical property, mirrors in LTR).

### G.2 Universal page patterns

- **List pages:** page title + primary action (إنشاء) top-start; toolbar = search + status filter + date range; table with status badges; row click → document. Pagination cursor-based.
- **Document pages (invoice/voucher):** header strip = document number, status badge, dates, party; body = lines table; footer = totals block (subtotal/tax/total) end-aligned; action bar = حفظ مسودة · ترحيل · طباعة · قيد عكسي (contextual by status).
- **Every posted document** shows a "القيد المحاسبي" panel linking to its journal entries.
- **Every report figure** is a drill-down link → journal entry → source document.

### G.3 Dashboard concept

Role-aware. Owner/accountant sees: 4 KPI tiles (مبيعات الشهر، مجمل الربح، النقدية بالخزينة والبنوك، مستحق من العملاء / للموردين) · مبيعات آخر ٣٠ يوم sparkline · أعمار الديون mini-bars · آخر المستندات list · تنبيهات (drafts unposted > 3 days, negative-margin invoices, period pending close). Sales role sees only their documents + stock lookups. No decorative charts — every tile clicks through to its report.

### G.4 Sales invoice page

Header: customer combobox (search by name/code, shows current balance + credit state inline) · warehouse select · date · payment terms. Lines table: item search combobox | qty (+ UoM) | **available-in-warehouse chip** (green/amber/red, live) | unit price (tolerance-checked) | VAT toggle | line total. Footer: subtotal / ضريبة 14% / الإجمالي + **live margin preview** (revenue vs avg cost — visible per role). Actions: حفظ مسودة → **ترحيل** (opens Posting Preview G.20) → after post: طباعة، سند قبض (shortcut, prefilled). Stock-short lines block posting with per-line error listing available qty.

### G.5 Purchase invoice page

Mirror of G.4: supplier header, unit cost column instead of price/margin; after-post side note: "متوسط تكلفة الصنف تحدّث من X إلى Y" per line (transparency the accountant will love). No account pickers anywhere.

#### G.5.1 Board-size entry (paint-board catalog)

The Elshrouq catalog is priced by **board area in square metres (م²)**, not by count or linear length. A purchase line therefore captures how many boards were bought and the area of each board. The current screen exposes too many raw fields (عدد + كبير + صغير + طول + عرض + م² + الكمية + الوحدة); the redesign MUST reduce this to the minimum a buyer actually thinks about:

- **عدد الألواح** — number of boards purchased (the count the user enters).
- **مقاس اللوح** — one choice, presented as three clear options:
  - **كبير = 5.25 م²** (standard large board area)
  - **صغير = 4 م²** (standard small board area)
  - **مخصص = طول × عرض** (custom board: enter طول and عرض, area is computed)
- **مساحة اللوح (م²)** — derived, read-only: 5.25 / 4 / (طول×عرض). MUST always display the selected standard value, not only for custom sizes (the Phase 1 bug).
- **إجمالي المساحة (م²)** — derived, read-only: عدد الألواح × مساحة اللوح. This is the line quantity that drives price and stock.

Design intent: the two derived fields (مساحة اللوح، إجمالي المساحة) are clearly labelled read-only outputs, visually separated from the inputs (عدد الألواح، مقاس اللوح), so the buyer never has to guess whether they are entering boards, length, or area. Standard vs custom must behave identically — both produce a per-board area and a total. The unit throughout is **م²**; avoid any "متر/م" label that implies linear metres. See A10 / T090 for the underlying naming-cleanup debt.

### G.6 Customer statement page

Party header card (balance, oldest open invoice, aging chips) · filters (period, نوع الحركة) · table: التاريخ | المستند (linked) | البيان | مدين | دائن | الرصيد — رصيد افتتاحي first row, رصيد ختامي footer · actions: طباعة / PDF / سند قبض shortcut.

### G.7 Supplier statement page — mirror of G.6 with سند صرف shortcut.

### G.8 Receipt voucher page

Two-column: form (customer → open invoices appear; amount; treasury account select — الخزينة أو بنك; date; reference/cheque no; memo) | allocation panel (open invoices list, auto-FIFO allocation editable per row, remainder shown as "على الحساب"). Posting preview → ترحيل → print (numbered A5-style voucher).

### G.9 Payment voucher page — mirror of G.8 for suppliers.

### G.10 Expenses page

List + quick-create side sheet: نوع المصروف (category select — drives account invisibly) · المبلغ · خاضع للضريبة؟ · طريقة الدفع (خزينة/بنك/على حساب مورد) · التاريخ · البيان · مرفق (receipt photo, v1.x). Categories managed in a settings tab, each mapped to a GL account once.

### G.11 Inventory balance page

Warehouse tabs or select · table: الصنف | الكمية | متوسط التكلفة | القيمة | آخر حركة → drill to movement history. Footer total value + reconciliation chip: "مطابق لحساب المخزون ✓" (or variance warning). Low-stock filter.

### G.12–G.16 Report pages (shared shell)

Shared report shell: filter bar (from/to + context filters) · summary tiles · table with sticky header · تصدير (print/PDF/Excel). Specific:
- **دفتر الأستاذ العام (G.13):** account OR party OR treasury picker; opening balance row; running balance column; every row links to its قيد.
- **قائمة الدخل (G.14):** statement layout (not a grid): المبيعات → (تكلفة البضاعة المباعة) → مجمل الربح → المصروفات by category → **صافي الربح** emphasized; comparison column (سابق الفترة) optional; each line expandable to accounts.
- **تقرير الضريبة (G.15):** period picker aligned to filing months; ضريبة المبيعات − ضريبة المشتريات = صافي المستحق; detail tabs (فواتير البيع / الشراء / المصروفات الخاضعة); print = ready worksheet for the tax return.
- Trial balance, balance sheet, aging, cash/bank movement follow the shell.

### G.16 Settings / Admin area — full specification (v2)

Settings is a **first-class module**, not a page: its own two-level navigation (settings sidebar inside the settings route), search across all settings, and a change-log tab on every protected screen.

**Settings navigation (15 screens):**

```
⚙️ الإعدادات
   بيانات الشركة          | company profile, logo upload w/ live sidebar preview, brand color picker,
                            currency (locked after first posting, shown with lock+tooltip), tax reg no,
                            fiscal year start, print footer
   الفروع والمخازن         | two tabs; CRUD tables; deactivate guards ("لا يمكن إلغاء مخزن به رصيد")
   المستخدمون والصلاحيات   | users table + role assign + branch access + default vault/warehouse per user;
                            read-only permission matrix grid (who-can-what) for transparency
   العملاء والموردون        | master data tables (also reachable from Sales/Purchases sections)
   الأصناف ووحدات القياس    | items table + UoM pair config (base unit, alt unit, conversion factor);
                            conversion locked once movements exist (lock badge + explainer)
   البنوك والخزائن          | treasury accounts: type chip CASH/BANK, linked GL account (auto), bank meta,
                            balance column, deactivate guard at zero balance
   دليل الحسابات            | COA tree (see prompt 14); system accounts show 🔒 with "حساب نظامي" tooltip
   إعدادات الترحيل          | purpose→account mapping form; OWNER-only banner; versions timeline
                            ("ساري من 01/07/2026") + effective-date picker on save; change log tab
   إعدادات الضريبة          | tax profiles list with versions; rate, in/out accounts, registration status,
                            filing cycle; "الفواتير القديمة تحتفظ بنسبتها" permanent note
   إعدادات التكلفة          | method display (متوسط التكلفة); change = guarded wizard (effective date,
                            open-drafts check, OWNER confirm, valuation snapshot download)
   أنواع المصروفات          | category ↔ account table, taxable default toggle
   تسلسل أرقام المستندات    | per-document series editor: prefix, next no, padding, سنوي reset toggle,
                            per-branch toggle; preview chip "PI-2026-00042"
   قوالب الطباعة            | per-document template editor: field toggles, footer, signatures, paper size,
                            branding policy (الحالي/كما طُبع), live A4 preview pane
   الفترات المحاسبية        | year grid, close checklist modal, reopen w/ reason (OWNER)
   اللغة والتنسيقات          | company default locale, per-user override note, date/number format display
```

**Shared settings patterns:** every protected screen = (form | versions timeline | change log) tabs · destructive/structural actions always guarded with consequence text · effective-date picker appears on any posting-affecting change · every save writes an audit row visible in the change-log tab · "wizard mode" reuses these exact screens during first-run company setup (stepper shell around them, trial-balance check gate at the end).

### G.17 Empty states

Every list: icon + one sentence + primary action ("لا توجد فواتير بعد — أنشئ أول فاتورة مبيعات"). Reports with no data in range: "لا توجد حركات في هذه الفترة" + widen-range shortcut. Never a bare empty table.

### G.18 Error states

- Field errors: inline under field, Arabic, specific ("الكمية المتاحة في مخزن X هي 40 متر فقط").
- Posting failures: modal listing each blocking reason with a fix link (e.g., "الفترة المحاسبية ٦/٢٠٢٦ مقفلة — راجع الفترات").
- Never show raw codes/stack; every API error code has a glossary-consistent Arabic message.
- Offline/5xx: retry banner preserving form state.

### G.19 Confirmation dialogs

Only for consequential actions, and they state the consequence, not "هل أنت متأكد؟" alone:
- **Post:** the Posting Preview *is* the confirmation (G.20).
- **Reverse:** "سيتم إنشاء قيد عكسي بتاريخ اليوم يلغي أثر الفاتورة رقم ١٢٣ — المخزون سيرتجع، ورصيد العميل سينقص ١١٤٠٠ ج.م" + reason field (mandatory).
- **Close period:** checklist result (drafts pending? reconciliation ok?) before enabling the button.
- Destructive button = danger color, start-positioned in RTL; cancel is the safe default focus.

### G.20 Posting Preview component (system-wide, before any financial post)

A standard panel/modal shown on every ترحيل:
```
معاينة القيد قبل الترحيل
─ القيد ١: فاتورة مبيعات ١٢٣
  مدين  حسابات العملاء / شركة النور     11,400.00
  دائن  المبيعات                        10,000.00
  دائن  ضريبة القيمة المضافة (مبيعات)    1,400.00
─ القيد ٢: تكلفة البضاعة المباعة
  مدين  تكلفة البضاعة المباعة            5,500.00
  دائن  المخزون                          5,500.00
─ حركة المخزون: مخزن الورّاق — صنف كذا −10 لوح (المتاح بعدها: 30)
[إلغاء]                      [تأكيد الترحيل]
```
Totals equality visibly asserted (✓ متوازن). Same component renders inside posted documents as the historical record.

---

*Design tokens, components, and design-agent prompts: see `design-system.md`.*
