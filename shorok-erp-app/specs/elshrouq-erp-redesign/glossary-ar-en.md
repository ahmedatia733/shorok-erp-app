# Arabic ↔ English Terminology Glossary (Ratified)

**Feature**: elshrouq-erp-redesign · **Rule**: UI labels MUST use the recommended terms below (Constitution IV). Business logic references i18n keys only.

Basis: standard Egyptian accounting curriculum + terminology used by ERP products common in the Egyptian/Arab market (Daftra, Qoyod, SMACC, Odoo-ar, Al-Ameen). No web research performed this session — terms below are standard, stable vocabulary; flag ⚠ items for client confirmation.

| English term | Recommended Arabic UI term | Common alternatives | Use in system | Notes on familiarity |
|---|---|---|---|---|
| General Ledger | دفتر الأستاذ العام | الأستاذ العام | ✅ دفتر الأستاذ العام | Universal; every Egyptian accountant knows it |
| Trial Balance | ميزان المراجعة | — | ✅ ميزان المراجعة | Universal |
| Chart of Accounts | دليل الحسابات | شجرة الحسابات | ✅ دليل الحسابات | «دليل» is the formal Egyptian term; «شجرة» common in software — keep as tree *visual*, label it دليل |
| Accounts Receivable | حسابات العملاء | المدينون، ذمم مدينة | ✅ حسابات العملاء | «ذمم» reads Gulf/Levant; Egyptian users say العملاء. Use المدينون only in trial balance context |
| Accounts Payable | حسابات الموردين | الدائنون، ذمم دائنة | ✅ حسابات الموردين | Same logic |
| Customer Statement | كشف حساب عميل | — | ✅ كشف حساب عميل | Universal |
| Supplier Statement | كشف حساب مورد | — | ✅ كشف حساب مورد | Universal |
| Receipt Voucher | سند قبض | إيصال استلام نقدية | ✅ سند قبض | Standard across all Arabic ERPs |
| Payment Voucher | سند صرف | إذن صرف | ✅ سند صرف | Standard; إذن صرف used in Egyptian gov context |
| Cash / Vault | الخزينة | الصندوق، الخزنة | ✅ الخزينة | Egyptian usage; الصندوق reads Levantine |
| Bank Account | حساب بنكي | مصرف | ✅ البنوك / حساب بنكي | Universal |
| Treasury (section) | الخزينة والبنوك | النقدية | ✅ الخزينة والبنوك | Matches how Egyptian accountants group it |
| Purchase Invoice | فاتورة مشتريات | فاتورة شراء | ✅ فاتورة مشتريات | Universal |
| Sales Invoice | فاتورة مبيعات | فاتورة بيع | ✅ فاتورة مبيعات | Universal |
| Inventory Movement | حركة المخزون | حركة الأصناف | ✅ حركة المخزون | Universal |
| Warehouse | مخزن (ج: المخازن) | مستودع | ✅ المخازن | «مستودع» is Gulf; Egypt says مخزن. ⚠ current app says «فروع» — branch and warehouse must become separate concepts |
| Operating Expenses | المصروفات التشغيلية | مصروفات عمومية وإدارية | ✅ المصروفات (section), التشغيلية in P&L | P&L can split عمومية وإدارية if client wants |
| COGS | تكلفة البضاعة المباعة | تكلفة المبيعات | ✅ تكلفة البضاعة المباعة | Textbook Egyptian term |
| Gross Profit | مجمل الربح | إجمالي الربح | ✅ مجمل الربح | Textbook term |
| Net Profit | صافي الربح | — | ✅ صافي الربح | Universal |
| VAT | ضريبة القيمة المضافة | — | ✅ ضريبة القيمة المضافة | 14% Egypt standard rate |
| Input VAT | ضريبة مشتريات (قابلة للخصم) | ضريبة مدخلات | ✅ ضريبة المشتريات | «مدخلات» is the tax-authority word; «مشتريات» clearer for users |
| Output VAT | ضريبة مبيعات | ضريبة مخرجات | ✅ ضريبة المبيعات | Same |
| Journal Entry | قيد يومية | قيد محاسبي | ✅ قيد يومية (list: القيود اليومية) | Universal |
| Posting / to post | ترحيل / ترحيل القيد | اعتماد | ✅ ترحيل | THE critical verb; every accountant knows ترحيل. Button: «ترحيل» |
| Draft | مسودة | غير مرحّل | ✅ مسودة | |
| Posted | مُرحّل | معتمد | ✅ مُرحّل | |
| Reversed | ملغي بقيد عكسي | معكوس | ✅ ملغي بقيد عكسي | Explicit = trustworthy |
| Opening Balance | رصيد افتتاحي | رصيد أول المدة | ✅ رصيد افتتاحي | أول المدة fine in statements |
| Debit / Credit | مدين / دائن | — | ✅ مدين / دائن | Universal |
| Financial Period | الفترة المحاسبية | الفترة المالية | ✅ الفترة المحاسبية | |
| Period Closing | إقفال الفترة | — | ✅ إقفال الفترة | |
| AR/AP Aging | أعمار الديون | تحليل أعمار الذمم | ✅ أعمار الديون | |
| Balance Sheet | الميزانية العمومية | قائمة المركز المالي | ✅ الميزانية العمومية | المركز المالي is IFRS-formal; owners know الميزانية |
| Income Statement / P&L | قائمة الدخل | حساب الأرباح والخسائر | ✅ قائمة الدخل (الأرباح والخسائر) | Show both on first use |
| Weighted Average Cost | متوسط التكلفة المرجح | التكلفة المتوسطة | ✅ متوسط التكلفة | |
| Stock Count | جرد المخزون | الجرد | ✅ جرد المخزون | |
| Allocation (voucher→invoice) | تسوية على الفواتير | تخصيص | ✅ تسوية | «تسوية» is the natural accountant word |
| Credit Note | إشعار دائن | مرتجع مبيعات | ✅ مرتجع مبيعات (doc), إشعار دائن (accounting) | Users think «مرتجع» |
| Debit Note | إشعار مدين | مرتجع مشتريات | ✅ مرتجع مشتريات | Same |
| Posting Preview | معاينة القيد | أثر القيد | ✅ معاينة القيد قبل الترحيل | New concept — label carefully |

---
