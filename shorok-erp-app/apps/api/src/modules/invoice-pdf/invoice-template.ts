import { cairoFontFaceCss } from "./fonts";

export interface InvoicePdfLine {
  code: string;
  name: string;
  size: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  subtotal: string;
  vat: string;
  total: string;
}

export interface InvoicePdfData {
  kind: "SALES" | "PURCHASE";
  companyName: string;
  invoiceNumber: string;
  status: string; // DRAFT | CONFIRMED | CANCELLED | REVERSED | PAID
  branchName: string;
  issueDate: string;
  dueDate?: string | null;
  party: { code?: string | null; name: string; phone?: string | null; address?: string | null; taxNumber?: string | null };
  representative?: string | null; // المندوب — shown when the invoice has one
  lines: InvoicePdfLine[];
  totals: { subtotal: string; vat: string; discount?: string | null; grandTotal: string };
  notes?: string | null;
  paymentStatus?: string | null;
  printedAt: string;
}

const esc = (s: string | null | undefined) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const STATUS_AR: Record<string, string> = {
  DRAFT: "مسودة", CONFIRMED: "مؤكدة", CANCELLED: "ملغاة", REVERSED: "معكوسة", PAID: "مدفوعة",
};

/** Full self-contained HTML for one invoice — RTL, embedded Cairo font, A4. */
export function buildInvoiceHtml(d: InvoicePdfData): string {
  const docType = d.kind === "SALES" ? "فاتورة مبيعات" : "فاتورة مشتريات";
  const partyLabel = d.kind === "SALES" ? "العميل" : "المورد";
  const priceLabel = d.kind === "SALES" ? "سعر البيع" : "سعر الشراء";
  const watermark = d.status === "DRAFT" ? "مسودة" : d.status === "CANCELLED" ? "ملغاة" : d.status === "REVERSED" ? "معكوسة" : "";

  const rows = d.lines.map((l, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td class="code">${esc(l.code)}</td>
        <td>${esc(l.name)}</td>
        <td class="c">${esc(l.size)}</td>
        <td class="c">${esc(l.unit)}</td>
        <td class="c">${esc(l.quantity)}</td>
        <td class="n">${esc(l.unitPrice)}</td>
        <td class="n">${esc(l.subtotal)}</td>
        <td class="n">${esc(l.vat)}</td>
        <td class="n">${esc(l.total)}</td>
      </tr>`).join("");

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<style>
${cairoFontFaceCss()}
@page { size: A4; margin: 14mm 12mm 18mm 12mm; }
* { box-sizing: border-box; }
body { font-family: 'Cairo', sans-serif; color: #1a1a1a; font-size: 11px; margin: 0; }
.header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1f4e79; padding-bottom: 8px; margin-bottom: 10px; }
.company { font-size: 18px; font-weight: 700; color: #1f4e79; }
.doctype { font-size: 15px; font-weight: 700; }
.meta { text-align: left; font-size: 11px; line-height: 1.7; }
.meta b { color: #1f4e79; }
.status { display: inline-block; border: 1px solid #1f4e79; color: #1f4e79; border-radius: 4px; padding: 1px 8px; font-weight: 700; font-size: 11px; }
.party { border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; background: #f6f8fa; }
.party .t { color: #1f4e79; font-weight: 700; margin-bottom: 2px; }
table.lines { width: 100%; border-collapse: collapse; }
table.lines thead { display: table-header-group; } /* repeat header on each page */
table.lines th { background: #1f4e79; color: #fff; font-weight: 700; padding: 5px 4px; font-size: 10.5px; border: 1px solid #1f4e79; }
table.lines td { padding: 4px; border: 1px solid #d0d7de; vertical-align: middle; }
table.lines tr { page-break-inside: avoid; }
.c { text-align: center; } .n { text-align: left; direction: ltr; font-variant-numeric: tabular-nums; } .code { font-family: monospace; direction: ltr; text-align: center; }
.totals { margin-top: 10px; width: 45%; margin-inline-start: auto; }
.totals div { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px dashed #d0d7de; }
.totals .grand { font-weight: 700; font-size: 13px; color: #1f4e79; border-bottom: 2px solid #1f4e79; }
.notes { margin-top: 10px; font-size: 10.5px; color: #444; }
.foot { margin-top: 10px; font-size: 9.5px; color: #888; }
.watermark { position: fixed; top: 42%; inset-inline-start: 0; width: 100%; text-align: center; font-size: 96px; font-weight: 700; color: rgba(200,0,0,0.12); transform: rotate(-24deg); z-index: 0; }
.content { position: relative; z-index: 1; }
</style>
</head>
<body>
${watermark ? `<div class="watermark">${watermark}</div>` : ""}
<div class="content">
  <div class="header">
    <div>
      <div class="company">${esc(d.companyName)}</div>
      <div class="doctype">${docType} — ${esc(d.invoiceNumber)}</div>
    </div>
    <div class="meta">
      <div><span class="status">${STATUS_AR[d.status] ?? esc(d.status)}</span></div>
      <div><b>الفرع:</b> ${esc(d.branchName)}</div>
      <div><b>التاريخ:</b> ${esc(d.issueDate)}</div>
      ${d.dueDate ? `<div><b>الاستحقاق:</b> ${esc(d.dueDate)}</div>` : ""}
      ${d.representative ? `<div><b>المندوب:</b> ${esc(d.representative)}</div>` : ""}
      ${d.paymentStatus ? `<div><b>حالة السداد:</b> ${esc(d.paymentStatus)}</div>` : ""}
    </div>
  </div>

  <div class="party">
    <div class="t">${partyLabel}</div>
    <div>${d.party.code ? `${esc(d.party.code)} — ` : ""}${esc(d.party.name)}</div>
    ${d.party.phone ? `<div>هاتف: ${esc(d.party.phone)}</div>` : ""}
    ${d.party.address ? `<div>العنوان: ${esc(d.party.address)}</div>` : ""}
    ${d.party.taxNumber ? `<div>الرقم الضريبي: ${esc(d.party.taxNumber)}</div>` : ""}
  </div>

  <table class="lines">
    <thead>
      <tr>
        <th>#</th><th>الكود</th><th>الصنف</th><th>المقاس</th><th>الوحدة</th><th>الكمية</th>
        <th>${priceLabel}</th><th>الإجمالي</th><th>الضريبة</th><th>الإجمالي شامل</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    <div><span>الإجمالي قبل الضريبة</span><span class="n">${esc(d.totals.subtotal)}</span></div>
    <div><span>ضريبة القيمة المضافة</span><span class="n">${esc(d.totals.vat)}</span></div>
    ${d.totals.discount && Number(d.totals.discount) > 0 ? `<div><span>الخصم</span><span class="n">${esc(d.totals.discount)}</span></div>` : ""}
    <div class="grand"><span>الإجمالي المستحق</span><span class="n">${esc(d.totals.grandTotal)}</span></div>
  </div>

  ${d.notes ? `<div class="notes"><b>ملاحظات:</b> ${esc(d.notes)}</div>` : ""}
  <div class="foot">${esc(d.companyName)} — تم الإنشاء: ${esc(d.printedAt)}</div>
</div>
</body>
</html>`;
}
