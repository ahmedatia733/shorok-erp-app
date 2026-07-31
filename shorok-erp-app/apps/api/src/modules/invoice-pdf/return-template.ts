import { cairoFontFaceCss } from "./fonts";

/** One returned line — all values are pre-formatted strings from stored snapshots. */
export interface ReturnPdfLine {
  code: string;
  name: string;
  color: string;
  dimensions: string;
  boards: string;
  metersPerBoard: string;
  meters: string;
  unitPrice: string;
  pricePerBoard: string;
  discount: string | null; // sales only
  net: string;
  taxRate: string;
  tax: string;
  total: string;
  reason: string;
  note: string;
}

export interface ReturnPdfData {
  kind: "SALES" | "PURCHASE";
  locale: "ar" | "en";
  companyName: string;
  returnNumber: string; // the return's OWN code, e.g. "SR-2" / "PR-3"
  status: "DRAFT" | "CONFIRMED" | "CANCELLED";
  returnDate: string;
  originalInvoiceNumber: string | null;
  originalInvoiceDate: string | null;
  branchName: string;
  partyCode: string | null;
  partyName: string;
  reason: string | null;
  notes: string | null;
  lines: ReturnPdfLine[];
  totals: {
    subtotal: string | null; // sales: gross before discount
    discount: string | null; // sales only
    net: string;
    tax: string;
    grandTotal: string;
    cogs: string | null; // sales COGS reversal
    inventoryOut: string | null; // purchase inventory value out
  };
  confirmedAt: string | null;
  confirmedBy: string | null;
  journalEntryNumber: string | null;
  printedAt: string;
}

const esc = (s: string | null | undefined) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Centralized PDF translation map — no user-visible string is hard-coded inline.
const T = {
  ar: {
    docSales: "مردود فاتورة مبيعات", docPurchase: "مردود فاتورة مشتريات",
    draftBadge: "مسودة — غير مرحّل", confirmedBadge: "مؤكد", cancelledBadge: "ملغي",
    watermark: "مسودة",
    branch: "الفرع", returnDate: "تاريخ المردود", origInvoice: "الفاتورة الأصلية", origInvoiceDate: "تاريخ الفاتورة",
    customer: "العميل", supplier: "المورد", reason: "السبب", notes: "ملاحظات",
    hIdx: "#", hCode: "الكود", hName: "الصنف", hColor: "اللون", hDims: "الأبعاد",
    hBoards: "الألواح", hMpb: "متر/لوح", hMeters: "الأمتار", hUnit: "سعر المتر", hPerBoard: "سعر اللوح",
    hDiscount: "الخصم", hNet: "قبل الضريبة", hRate: "الضريبة%", hTax: "الضريبة", hTotal: "الإجمالي", hNote: "ملاحظة/سبب",
    tSubtotal: "الإجمالي قبل الضريبة", tDiscount: "الخصم", tNet: "الصافي قبل الضريبة",
    tVatOut: "ض.ق.م المخرجات المعكوسة", tVatIn: "ض.ق.م المدخلات المعكوسة",
    tCustomerCredit: "إجمالي رصيد العميل", tSupplierDebit: "إجمالي خصم المورد",
    tCogs: "عكس تكلفة المبيعات", tInvOut: "قيمة المخزون الخارج",
    journal: "رقم القيد", confirmedAt: "تاريخ التأكيد", confirmedBy: "أكّده", printedAt: "تم الإنشاء",
  },
  en: {
    docSales: "Sales Invoice Return", docPurchase: "Purchase Invoice Return",
    draftBadge: "DRAFT — Not Posted", confirmedBadge: "CONFIRMED", cancelledBadge: "CANCELLED",
    watermark: "DRAFT",
    branch: "Branch", returnDate: "Return date", origInvoice: "Original invoice", origInvoiceDate: "Invoice date",
    customer: "Customer", supplier: "Supplier", reason: "Reason", notes: "Notes",
    hIdx: "#", hCode: "Code", hName: "Product", hColor: "Color", hDims: "Dimensions",
    hBoards: "Boards", hMpb: "m/board", hMeters: "Meters", hUnit: "Unit price", hPerBoard: "Price/board",
    hDiscount: "Discount", hNet: "Net ex-VAT", hRate: "VAT%", hTax: "VAT", hTotal: "Total", hNote: "Note/Reason",
    tSubtotal: "Subtotal (ex-VAT)", tDiscount: "Discount", tNet: "Net before VAT",
    tVatOut: "Reversed output VAT", tVatIn: "Reversed input VAT",
    tCustomerCredit: "Customer credit total", tSupplierDebit: "Supplier debit total",
    tCogs: "COGS reversal", tInvOut: "Inventory value removed", journal: "Journal entry",
    confirmedAt: "Confirmed at", confirmedBy: "Confirmed by", printedAt: "Generated",
  },
} as const;

/** Self-contained HTML for one return — RTL on ar, LTR on en, embedded Cairo. */
export function buildReturnHtml(d: ReturnPdfData): string {
  const t = T[d.locale];
  const rtl = d.locale === "ar";
  const isSales = d.kind === "SALES";
  const docType = isSales ? t.docSales : t.docPurchase;
  const partyLabel = isSales ? t.customer : t.supplier;
  const badge = d.status === "DRAFT" ? t.draftBadge : d.status === "CANCELLED" ? t.cancelledBadge : t.confirmedBadge;
  const watermark = d.status === "DRAFT" ? t.watermark : d.status === "CANCELLED" ? t.cancelledBadge : "";

  const rows = d.lines.map((l, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td class="code">${esc(l.code)}</td>
        <td>${esc(l.name)}</td>
        <td class="c">${esc(l.color)}</td>
        <td class="c">${esc(l.dimensions)}</td>
        <td class="c">${esc(l.boards)}</td>
        <td class="c">${esc(l.metersPerBoard)}</td>
        <td class="c">${esc(l.meters)}</td>
        <td class="n">${esc(l.unitPrice)}</td>
        <td class="n">${esc(l.pricePerBoard)}</td>
        ${isSales ? `<td class="n">${esc(l.discount)}</td>` : ""}
        <td class="n">${esc(l.net)}</td>
        <td class="c">${esc(l.taxRate)}</td>
        <td class="n">${esc(l.tax)}</td>
        <td class="n">${esc(l.total)}</td>
        <td>${esc([l.reason, l.note].filter(Boolean).join(" — "))}</td>
      </tr>`).join("");

  const totalsRows = isSales
    ? [
        d.totals.subtotal ? `<div><span>${t.tSubtotal}</span><span class="n">${esc(d.totals.subtotal)}</span></div>` : "",
        d.totals.discount && Number(d.totals.discount) > 0 ? `<div><span>${t.tDiscount}</span><span class="n">${esc(d.totals.discount)}</span></div>` : "",
        `<div><span>${t.tNet}</span><span class="n">${esc(d.totals.net)}</span></div>`,
        `<div><span>${t.tVatOut}</span><span class="n">${esc(d.totals.tax)}</span></div>`,
        `<div class="grand"><span>${t.tCustomerCredit}</span><span class="n">${esc(d.totals.grandTotal)}</span></div>`,
        d.totals.cogs ? `<div class="muted"><span>${t.tCogs}</span><span class="n">${esc(d.totals.cogs)}</span></div>` : "",
      ]
    : [
        `<div><span>${t.tNet}</span><span class="n">${esc(d.totals.net)}</span></div>`,
        `<div><span>${t.tVatIn}</span><span class="n">${esc(d.totals.tax)}</span></div>`,
        `<div class="grand"><span>${t.tSupplierDebit}</span><span class="n">${esc(d.totals.grandTotal)}</span></div>`,
        d.totals.inventoryOut ? `<div class="muted"><span>${t.tInvOut}</span><span class="n">${esc(d.totals.inventoryOut)}</span></div>` : "",
      ];

  return `<!doctype html>
<html lang="${d.locale}" dir="${rtl ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<style>
${cairoFontFaceCss()}
@page { size: A4; margin: 14mm 12mm 18mm 12mm; }
* { box-sizing: border-box; }
body { font-family: 'Cairo', sans-serif; color: #1a1a1a; font-size: 10.5px; margin: 0; }
.header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #7a1f2b; padding-bottom: 8px; margin-bottom: 10px; }
.company { font-size: 18px; font-weight: 700; color: #7a1f2b; }
.doctype { font-size: 15px; font-weight: 700; }
.meta { text-align: ${rtl ? "left" : "right"}; font-size: 10.5px; line-height: 1.7; }
.meta b { color: #7a1f2b; }
.status { display: inline-block; border: 1px solid #7a1f2b; color: #7a1f2b; border-radius: 4px; padding: 1px 8px; font-weight: 700; font-size: 11px; }
.status.draft { background: #fff4e5; border-color: #b26a00; color: #b26a00; }
.party { border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; background: #f6f8fa; }
.party .t { color: #7a1f2b; font-weight: 700; margin-bottom: 2px; }
table.lines { width: 100%; border-collapse: collapse; }
table.lines thead { display: table-header-group; }
table.lines th { background: #7a1f2b; color: #fff; font-weight: 700; padding: 4px 3px; font-size: 9.5px; border: 1px solid #7a1f2b; }
table.lines td { padding: 3px; border: 1px solid #d0d7de; vertical-align: middle; font-size: 9.5px; }
table.lines tr { page-break-inside: avoid; }
.c { text-align: center; } .n { text-align: ${rtl ? "left" : "right"}; direction: ltr; font-variant-numeric: tabular-nums; } .code { font-family: monospace; direction: ltr; text-align: center; }
.totals { margin-top: 10px; width: 55%; margin-inline-start: auto; }
.totals div { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px dashed #d0d7de; }
.totals .grand { font-weight: 700; font-size: 13px; color: #7a1f2b; border-bottom: 2px solid #7a1f2b; }
.totals .muted { color: #666; }
.notes { margin-top: 10px; font-size: 10px; color: #444; }
.foot { margin-top: 10px; font-size: 9px; color: #888; }
.watermark { position: fixed; top: 42%; inset-inline-start: 0; width: 100%; text-align: center; font-size: 92px; font-weight: 700; color: rgba(160,0,0,0.10); transform: rotate(-24deg); z-index: 0; }
.content { position: relative; z-index: 1; }
</style>
</head>
<body>
${watermark ? `<div class="watermark">${esc(watermark)}</div>` : ""}
<div class="content">
  <div class="header">
    <div>
      <div class="company">${esc(d.companyName)}</div>
      <div class="doctype">${docType} — ${esc(d.returnNumber)}</div>
    </div>
    <div class="meta">
      <div><span class="status ${d.status === "DRAFT" ? "draft" : ""}">${esc(badge)}</span></div>
      <div><b>${t.branch}:</b> ${esc(d.branchName)}</div>
      <div><b>${t.returnDate}:</b> ${esc(d.returnDate)}</div>
      ${d.originalInvoiceNumber ? `<div><b>${t.origInvoice}:</b> ${esc(d.originalInvoiceNumber)}</div>` : ""}
      ${d.originalInvoiceDate ? `<div><b>${t.origInvoiceDate}:</b> ${esc(d.originalInvoiceDate)}</div>` : ""}
      ${d.status === "CONFIRMED" && d.journalEntryNumber ? `<div><b>${t.journal}:</b> ${esc(d.journalEntryNumber)}</div>` : ""}
      ${d.status === "CONFIRMED" && d.confirmedAt ? `<div><b>${t.confirmedAt}:</b> ${esc(d.confirmedAt)}</div>` : ""}
      ${d.status === "CONFIRMED" && d.confirmedBy ? `<div><b>${t.confirmedBy}:</b> ${esc(d.confirmedBy)}</div>` : ""}
    </div>
  </div>

  <div class="party">
    <div class="t">${partyLabel}</div>
    <div>${d.partyCode ? `${esc(d.partyCode)} — ` : ""}${esc(d.partyName)}</div>
  </div>

  <table class="lines">
    <thead>
      <tr>
        <th>${t.hIdx}</th><th>${t.hCode}</th><th>${t.hName}</th><th>${t.hColor}</th><th>${t.hDims}</th>
        <th>${t.hBoards}</th><th>${t.hMpb}</th><th>${t.hMeters}</th><th>${t.hUnit}</th><th>${t.hPerBoard}</th>
        ${isSales ? `<th>${t.hDiscount}</th>` : ""}<th>${t.hNet}</th><th>${t.hRate}</th><th>${t.hTax}</th><th>${t.hTotal}</th><th>${t.hNote}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">${totalsRows.filter(Boolean).join("")}</div>

  ${d.reason ? `<div class="notes"><b>${t.reason}:</b> ${esc(d.reason)}</div>` : ""}
  ${d.notes ? `<div class="notes"><b>${t.notes}:</b> ${esc(d.notes)}</div>` : ""}
  <div class="foot">${esc(d.companyName)} — ${t.printedAt}: ${esc(d.printedAt)}</div>
</div>
</body>
</html>`;
}
