import { cairoFontFaceCss } from "../invoice-pdf/fonts";

/**
 * The printable face of تقرير ربحية الفواتير.
 *
 * Pure builders: data in, HTML string out. Nothing here touches the database,
 * which is what lets the export be proven non-mutating. Arabic comes out
 * connected and right-to-left because Cairo is embedded as a base64 @font-face
 * and Chromium does the shaping — the same path every other PDF in this
 * codebase takes.
 *
 * The one editorial decision worth naming: where cost was never recorded, the
 * cost and profit cells print «غير متاحة», not `0.00`. A printed report outlives
 * the screen that produced it, so an unknown must stay visibly unknown.
 */

const esc = (s: string | null | undefined): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Arabic-Indic grouping, matching how the screens print money. */
const num = (v: string | number | null | undefined, dp = 2): string => {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return esc(String(v));
  return n.toLocaleString("ar-EG", { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

/** An amount that is genuinely unknown, never a confident zero. */
const unknown = `<span class="unk">غير متاحة</span>`;
const money = (v: string | null): string =>
  v === null ? unknown : Number(v) < 0 ? `<span class="neg">${num(v)}</span>` : num(v);
const pct = (v: string | null): string => (v === null ? "—" : `${num(v)}%`);

const dateAr = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleDateString("ar-EG", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" });
};

const COVERAGE_AR: Record<string, string> = {
  COMPLETE: "مكتملة",
  PARTIAL: "غير مكتملة",
  MISSING: "غير مسجّلة",
};

export interface ProfitabilityPdfMeta {
  company: string;
  printedAt: Date;
  filters: Array<{ label: string; value: string }>;
}

interface InvoiceRow {
  invoiceNumber: string;
  invoiceDate: string;
  customerCode: string | null;
  customerName: string | null;
  branchName: string | null;
  salesRepresentativeName: string | null;
  status: string;
  salesBeforeDiscount: string;
  discount: string;
  netSalesExVat: string;
  tax: string;
  grandTotal: string;
  cogs: string | null;
  grossProfit: string | null;
  marginPct: string | null;
  returnNetExVat: string;
  returnCogs: string | null;
  finalNetSalesExVat: string;
  finalCogs: string | null;
  finalProfit: string | null;
  finalMarginPct: string | null;
  costCoverage: string;
}

interface Summary {
  invoiceCount: number;
  netSalesExVat: string;
  costedInvoiceCount: number;
  costedNetSalesExVat: string;
  historicalCogs: string;
  grossProfit: string;
  grossMarginPct: string | null;
  linkedReturnsNetExVat: string;
  linkedReturnsCogs: string;
  finalNetSalesExVat: string;
  finalCogs: string;
  finalGrossProfit: string;
  finalGrossMarginPct: string | null;
  incompleteCostInvoiceCount: number;
  incompleteCostNetSales: string;
}

const printedAtAr = (d: Date): string =>
  d.toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" });

/**
 * The page shell.
 *
 * `thead { display: table-header-group }` repeats the header on every page and
 * `tr { break-inside: avoid }` stops a row being sliced across a break — the two
 * rules that make a long Arabic table readable on paper. Page numbers come from
 * Chromium's footer template, never counted here.
 */
function shell(title: string, meta: ProfitabilityPdfMeta, body: string, note: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
${cairoFontFaceCss()}
@page { size: A4 landscape; margin: 12mm 10mm 16mm 10mm; }
* { box-sizing: border-box; }
body {
  font-family: 'Cairo', sans-serif; direction: rtl; text-align: right;
  color: #1f2937; font-size: 10px; margin: 0; padding: 0; background: #fff;
}
.head { border-bottom: 2px solid #111827; padding-bottom: 8px; margin-bottom: 10px; }
.company { font-size: 15px; font-weight: 700; }
.title { font-size: 18px; font-weight: 700; margin-top: 2px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-top: 6px; color: #4b5563; font-size: 10px; }
.meta b { color: #111827; font-weight: 700; }
h2 { font-size: 12px; margin: 12px 0 5px; padding-bottom: 3px; border-bottom: 1px solid #d1d5db; }
table { width: 100%; border-collapse: collapse; margin-top: 4px; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { border: 1px solid #d1d5db; padding: 3px 5px; text-align: right; vertical-align: top; }
th { background: #f3f4f6; font-weight: 700; font-size: 9px; }
td.num, th.num { text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap; }
tbody tr:nth-child(even) { background: #fafafa; }
tfoot td { background: #f3f4f6; font-weight: 700; }
.cards { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 6px; }
.card { flex: 1 1 22%; min-width: 130px; border: 1px solid #d1d5db; border-radius: 5px; padding: 7px 9px; }
.card .k { color: #6b7280; font-size: 9px; }
.card .v { font-size: 14px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
.card.warn { border-color: #b45309; background: #fffbeb; }
.muted { color: #6b7280; }
.neg { color: #b91c1c; }
.unk { color: #b45309; font-style: italic; }
.warnbox { margin-top: 8px; border: 1px solid #b45309; background: #fffbeb; border-radius: 5px; padding: 7px 9px; font-size: 10px; }
.note { margin-top: 10px; font-size: 9px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 5px; }
.empty { padding: 16px; text-align: center; color: #6b7280; border: 1px dashed #d1d5db; }
</style>
</head>
<body>
  <div class="head">
    <div class="company">${esc(meta.company)}</div>
    <div class="title">${esc(title)}</div>
    <div class="meta">
      <span><b>تاريخ الإصدار:</b> ${esc(printedAtAr(meta.printedAt))}</span>
      ${meta.filters.map((f) => `<span><b>${esc(f.label)}:</b> ${esc(f.value)}</span>`).join("")}
    </div>
  </div>
  ${body}
  <div class="note">${note}</div>
</body>
</html>`;
}

const BASIS_NOTE =
  "الربح المعروض هو إجمالي ربح الفواتير: صافي المبيعات بدون الضريبة ناقص تكلفة البضاعة المباعة التاريخية " +
  "المسجّلة وقت ترحيل الفاتورة. الضريبة ليست ربحاً ولا تدخل في الحساب، والمصروفات التشغيلية العامة لا تُوزَّع " +
  "على الفواتير. تشمل الفواتير المؤكدة فقط، وتُخصم منها مردودات المبيعات المؤكدة المرتبطة بالفاتورة. " +
  "المبالغ بالجنيه المصري.";

/** The whole filtered report: summary cards, then one row per invoice. */
export function buildInvoiceProfitabilityPdf(input: {
  company: string;
  printedAt: Date;
  from: string;
  to: string;
  filters: Array<{ label: string; value: string }>;
  summary: Summary;
  invoices: InvoiceRow[];
}): string {
  const { summary: s } = input;
  const meta: ProfitabilityPdfMeta = { company: input.company, printedAt: input.printedAt, filters: input.filters };

  const cards = [
    { k: "عدد الفواتير", v: String(s.invoiceCount) },
    { k: "إجمالي صافي المبيعات بدون الضريبة", v: num(s.netSalesExVat) },
    { k: "إجمالي تكلفة البضاعة المباعة", v: num(s.historicalCogs) },
    { k: "إجمالي الربح", v: num(s.grossProfit) },
    { k: "هامش الربح", v: pct(s.grossMarginPct) },
    { k: "إجمالي مردودات المبيعات المرتبطة", v: num(s.linkedReturnsNetExVat) },
    { k: "تكلفة البضاعة المرتجعة", v: num(s.linkedReturnsCogs) },
    { k: "صافي المبيعات بعد المرتجعات", v: num(s.finalNetSalesExVat) },
    { k: "صافي التكلفة بعد المرتجعات", v: num(s.finalCogs) },
    { k: "صافي الربح بعد المرتجعات", v: num(s.finalGrossProfit) },
    { k: "هامش الربح النهائي", v: pct(s.finalGrossMarginPct) },
  ];

  const incomplete = s.incompleteCostInvoiceCount > 0
    ? `<div class="warnbox">
         <b>تنبيه:</b> ${s.incompleteCostInvoiceCount} فاتورة بتكلفة تاريخية غير مكتملة،
         بصافي مبيعات ${num(s.incompleteCostNetSales)} ج.م. هذه الفواتير مستبعدة من أرقام التكلفة والربح أعلاه،
         لأن تكلفتها لم تُسجَّل وقت البيع ولا يمكن استنتاجها. أرقام الربح تخص ${s.costedInvoiceCount} فاتورة
         بصافي مبيعات ${num(s.costedNetSalesExVat)} ج.م.
       </div>`
    : "";

  const rows = input.invoices.length === 0
    ? `<div class="empty">لا توجد فواتير مطابقة للفلاتر المحددة.</div>`
    : `<table>
        <thead>
          <tr>
            <th>رقم الفاتورة</th><th>التاريخ</th><th>العميل</th><th>الفرع</th><th>المندوب</th>
            <th class="num">قبل الخصم</th><th class="num">الخصم</th>
            <th class="num">صافي المبيعات بدون ض.</th><th class="num">الضريبة</th><th class="num">الإجمالي</th>
            <th class="num">التكلفة التاريخية</th><th class="num">الربح</th><th class="num">الهامش</th>
            <th class="num">المرتجعات</th><th class="num">تكلفة المرتجع</th>
            <th class="num">صافي المبيعات بعد المرتجع</th><th class="num">صافي الربح</th><th class="num">الهامش النهائي</th>
            <th>اكتمال التكلفة</th>
          </tr>
        </thead>
        <tbody>
          ${input.invoices
            .map(
              (r) => `<tr>
            <td>${esc(r.invoiceNumber)}</td>
            <td>${dateAr(r.invoiceDate)}</td>
            <td>${esc(r.customerCode ? `${r.customerCode} — ${r.customerName ?? ""}` : r.customerName)}</td>
            <td>${esc(r.branchName)}</td>
            <td>${esc(r.salesRepresentativeName ?? "—")}</td>
            <td class="num">${num(r.salesBeforeDiscount)}</td>
            <td class="num">${num(r.discount)}</td>
            <td class="num">${num(r.netSalesExVat)}</td>
            <td class="num">${num(r.tax)}</td>
            <td class="num">${num(r.grandTotal)}</td>
            <td class="num">${money(r.cogs)}</td>
            <td class="num">${money(r.grossProfit)}</td>
            <td class="num">${pct(r.marginPct)}</td>
            <td class="num">${num(r.returnNetExVat)}</td>
            <td class="num">${money(r.returnCogs)}</td>
            <td class="num">${num(r.finalNetSalesExVat)}</td>
            <td class="num">${money(r.finalProfit)}</td>
            <td class="num">${pct(r.finalMarginPct)}</td>
            <td>${esc(COVERAGE_AR[r.costCoverage] ?? r.costCoverage)}</td>
          </tr>`,
            )
            .join("")}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="7">الإجمالي (${input.invoices.length} فاتورة)</td>
            <td class="num">${num(s.netSalesExVat)}</td>
            <td class="num">—</td>
            <td class="num">—</td>
            <td class="num">${num(s.historicalCogs)}</td>
            <td class="num">${num(s.grossProfit)}</td>
            <td class="num">${pct(s.grossMarginPct)}</td>
            <td class="num">${num(s.linkedReturnsNetExVat)}</td>
            <td class="num">${num(s.linkedReturnsCogs)}</td>
            <td class="num">${num(s.finalNetSalesExVat)}</td>
            <td class="num">${num(s.finalGrossProfit)}</td>
            <td class="num">${pct(s.finalGrossMarginPct)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>`;

  return shell(
    "تقرير ربحية الفواتير",
    meta,
    `<div class="cards">${cards.map((c) => `<div class="card"><div class="k">${esc(c.k)}</div><div class="v">${c.v}</div></div>`).join("")}</div>
     ${incomplete}
     <h2>الفواتير</h2>
     ${rows}`,
    BASIS_NOTE,
  );
}

/** One invoice, line by line. */
export function buildInvoiceProfitabilityDetailPdf(input: {
  company: string;
  printedAt: Date;
  detail: {
    invoice: InvoiceRow & { revisionNumber: number; linesMissingCost: number };
    lines: Array<{
      productCode: string;
      productName: string;
      variantSize: string;
      sizeMode: string;
      lengthM: string | null;
      widthM: string | null;
      boards: string;
      meters: string;
      salePricePerMeter: string;
      discount: string;
      netSalesExVat: string;
      costPerMeterAtPosting: string | null;
      cogs: string | null;
      grossProfit: string | null;
      marginPct: string | null;
      returnedBoards: string;
      returnNetExVat: string;
      returnCogs: string | null;
      finalNetSalesExVat: string;
      finalCogs: string | null;
      finalProfit: string | null;
      costBasis: string;
    }>;
    returns: Array<{ returnNumber: string; returnDate: string; netExVat: string; cogs: string; boards: string }>;
  };
}): string {
  const { invoice: inv, lines, returns } = input.detail;
  const meta: ProfitabilityPdfMeta = {
    company: input.company,
    printedAt: input.printedAt,
    filters: [
      { label: "رقم الفاتورة", value: inv.invoiceNumber },
      { label: "التاريخ", value: dateAr(inv.invoiceDate) },
      { label: "العميل", value: inv.customerCode ? `${inv.customerCode} — ${inv.customerName ?? ""}` : inv.customerName ?? "—" },
      { label: "الفرع", value: inv.branchName ?? "—" },
      ...(inv.salesRepresentativeName ? [{ label: "مندوب المبيعات", value: inv.salesRepresentativeName }] : []),
      ...(inv.revisionNumber > 1 ? [{ label: "رقم المراجعة", value: String(inv.revisionNumber) }] : []),
    ],
  };

  const sizeAr = (l: { sizeMode: string; variantSize: string; lengthM: string | null; widthM: string | null }): string => {
    const badge = l.sizeMode === "LARGE" ? "كبير" : l.sizeMode === "SMALL" ? "صغير" : l.sizeMode === "CUSTOM" ? "مخصص" : "افتراضي";
    const dims = l.lengthM ? ` (${num(l.lengthM, 2)}${l.widthM ? ` × ${num(l.widthM, 2)}` : ""} م)` : "";
    return `${badge} — ${num(l.variantSize, 2)} م${dims}`;
  };

  const cards = [
    { k: "صافي المبيعات بدون الضريبة", v: num(inv.netSalesExVat) },
    { k: "التكلفة التاريخية", v: inv.cogs === null ? "غير متاحة" : num(inv.cogs) },
    { k: "إجمالي الربح", v: inv.grossProfit === null ? "غير متاحة" : num(inv.grossProfit) },
    { k: "هامش الربح", v: pct(inv.marginPct) },
    { k: "المرتجعات المرتبطة", v: num(inv.returnNetExVat) },
    { k: "صافي الربح بعد المرتجعات", v: inv.finalProfit === null ? "غير متاحة" : num(inv.finalProfit) },
  ];

  const warn = inv.costCoverage !== "COMPLETE"
    ? `<div class="warnbox"><b>التكلفة التاريخية غير مكتملة:</b> ${inv.linesMissingCost} بند من بنود هذه الفاتورة
       بلا تكلفة مسجّلة وقت البيع، لذلك لا يمكن عرض ربح موثوق لها. أرقام المبيعات صحيحة ومكتملة.</div>`
    : "";

  const linesTable = `<table>
    <thead>
      <tr>
        <th>كود الصنف</th><th>الصنف</th><th>المقاس</th>
        <th class="num">الألواح</th><th class="num">الأمتار</th>
        <th class="num">سعر المتر</th><th class="num">الخصم</th><th class="num">صافي البيع</th>
        <th class="num">تكلفة المتر وقت البيع</th><th class="num">التكلفة</th>
        <th class="num">الربح</th><th class="num">الهامش</th>
        <th class="num">مرتجع</th><th class="num">قيمة المرتجع</th><th class="num">صافي ربح البند</th>
      </tr>
    </thead>
    <tbody>
      ${lines
        .map(
          (l) => `<tr>
        <td>${esc(l.productCode)}</td>
        <td>${esc(l.productName)}</td>
        <td>${esc(sizeAr(l))}</td>
        <td class="num">${num(l.boards, 2)}</td>
        <td class="num">${num(l.meters, 2)}</td>
        <td class="num">${num(l.salePricePerMeter)}</td>
        <td class="num">${num(l.discount)}</td>
        <td class="num">${num(l.netSalesExVat)}</td>
        <td class="num">${l.costPerMeterAtPosting === null ? unknown : num(l.costPerMeterAtPosting, 4)}</td>
        <td class="num">${money(l.cogs)}</td>
        <td class="num">${money(l.grossProfit)}</td>
        <td class="num">${pct(l.marginPct)}</td>
        <td class="num">${num(l.returnedBoards, 2)}</td>
        <td class="num">${num(l.returnNetExVat)}</td>
        <td class="num">${money(l.finalProfit)}</td>
      </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;

  const returnsTable = returns.length
    ? `<h2>مردودات المبيعات المرتبطة</h2>
       <table>
         <thead><tr><th>رقم المرتجع</th><th>التاريخ</th><th class="num">الألواح</th><th class="num">القيمة بدون ضريبة</th><th class="num">التكلفة المعكوسة</th></tr></thead>
         <tbody>${returns
           .map(
             (r) => `<tr><td>${esc(r.returnNumber)}</td><td>${dateAr(r.returnDate)}</td>
             <td class="num">${num(r.boards, 2)}</td><td class="num">${num(r.netExVat)}</td><td class="num">${num(r.cogs)}</td></tr>`,
           )
           .join("")}</tbody>
       </table>`
    : "";

  return shell(
    `ربحية الفاتورة رقم ${inv.invoiceNumber}`,
    meta,
    `<div class="cards">${cards.map((c) => `<div class="card"><div class="k">${esc(c.k)}</div><div class="v">${c.v}</div></div>`).join("")}</div>
     ${warn}
     <h2>بنود الفاتورة</h2>
     ${linesTable}
     ${returnsTable}`,
    BASIS_NOTE,
  );
}
