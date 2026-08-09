import type { LegacyReturnDetail, LegacyReturnRow } from "@shorok/shared";
import { cairoFontFaceCss } from "../invoice-pdf/fonts";

/**
 * The printable face of «مردودات بدون فواتير».
 *
 * Same shell as the rest of the ERP's documents: Cairo embedded as a base64
 * @font-face so Chromium shapes Arabic properly, right-to-left throughout, and
 * a repeating table header so a long list stays readable on paper.
 *
 * Pure: data in, HTML out. Nothing here reads or writes the database, which is
 * what lets the export be proven non-mutating.
 */

const esc = (s: string | null | undefined): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const num = (v: string | number): string => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : esc(String(v));
};

const qty = (v: string): string => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? String(n) : esc(v);
};

const dateAr = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? esc(iso)
    : d.toLocaleDateString("ar-EG", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" });
};

const STATUS_AR: Record<string, string> = { DRAFT: "مسودة", CONFIRMED: "مؤكد", CANCELLED: "ملغي" };

export interface LegacyReturnPdfMeta {
  companyName: string;
  printedAt: string;
  filters: Array<{ label: string; value: string }>;
}

function shell(title: string, meta: LegacyReturnPdfMeta, body: string, watermark?: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8" /><title>${esc(title)}</title>
<style>
${cairoFontFaceCss()}
@page { size: A4; margin: 14mm 12mm 18mm 12mm; }
* { box-sizing: border-box; }
body { font-family: 'Cairo', sans-serif; direction: rtl; text-align: right; color: #1f2937; font-size: 11px; margin: 0; background: #fff; position: relative; }
.head { border-bottom: 2px solid #111827; padding-bottom: 8px; margin-bottom: 12px; }
.company { font-size: 15px; font-weight: 700; }
.title { font-size: 18px; font-weight: 700; margin-top: 2px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-top: 6px; color: #4b5563; font-size: 10px; }
.meta b { color: #111827; }
.facts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.fact { flex: 1 1 30%; min-width: 150px; border: 1px solid #d1d5db; border-radius: 5px; padding: 6px 9px; }
.fact .k { color: #6b7280; font-size: 10px; }
.fact .v { font-weight: 700; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; margin-top: 4px; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { border: 1px solid #d1d5db; padding: 4px 6px; text-align: right; vertical-align: top; }
th { background: #f3f4f6; font-weight: 700; font-size: 10px; }
td.num, th.num { text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap; }
tbody tr:nth-child(even) { background: #fafafa; }
tfoot td { background: #f3f4f6; font-weight: 700; }
.badge { display: inline-block; border: 1px solid #9ca3af; border-radius: 3px; padding: 0 5px; font-size: 10px; }
.settle { margin-top: 10px; border: 1px solid #111827; border-radius: 5px; padding: 8px 10px; font-weight: 700; }
.note { margin-top: 10px; font-size: 9px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 5px; }
.empty { padding: 16px; text-align: center; color: #6b7280; border: 1px dashed #d1d5db; }
.wm { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 90px; font-weight: 700; color: rgba(185,28,28,.12); transform: rotate(-30deg); z-index: 0; }
.content { position: relative; z-index: 1; }
</style></head>
<body>
  ${watermark ? `<div class="wm">${esc(watermark)}</div>` : ""}
  <div class="content">
    <div class="head">
      <div class="company">${esc(meta.companyName)}</div>
      <div class="title">${esc(title)}</div>
      <div class="meta">
        <span><b>تاريخ الطباعة:</b> ${esc(meta.printedAt)}</span>
        ${meta.filters.map((f) => `<span><b>${esc(f.label)}:</b> ${esc(f.value)}</span>`).join("")}
      </div>
    </div>
    ${body}
    <div class="note">
      مردود بضاعة مباعة قبل تشغيل النظام — الفاتورة الورقية مرجع فقط ولا يوجد لها نظير إلكتروني.
      قيمة المرتجع تُضاف إلى حساب العميل، ولا يوجد أي صرف نقدي أو بنكي.
    </div>
  </div>
</body></html>`;
}

/** One document. */
export function buildLegacyReturnPdf(d: LegacyReturnDetail, meta: LegacyReturnPdfMeta): string {
  const facts = [
    { k: "رقم المرتجع", v: `LRN-${esc(d.returnNumber)}` },
    { k: "الحالة", v: STATUS_AR[d.status] ?? esc(d.status) },
    { k: "تاريخ المرتجع", v: dateAr(d.returnDate) },
    { k: "العميل", v: `${esc(d.customerNameAr)}${d.customerCode ? ` (${esc(d.customerCode)})` : ""}` },
    { k: "رقم الفاتورة الورقية", v: esc(d.paperInvoiceNumber) },
    { k: "تاريخ الفاتورة الأصلية", v: dateAr(d.paperInvoiceDate) },
    { k: "المخزن", v: esc(d.branchNameAr) },
    { k: "أنشأ بواسطة", v: esc(d.createdByName) },
    ...(d.confirmedByName ? [{ k: "أكّد بواسطة", v: esc(d.confirmedByName) }] : []),
    ...(d.cancelledByName ? [{ k: "ألغى بواسطة", v: esc(d.cancelledByName) }] : []),
  ];

  const rows = d.lines
    .map(
      (l) => `<tr>
      <td>${esc(l.productCode)}</td>
      <td>${esc(l.productNameAr)}</td>
      <td><span class="badge">${esc(l.sizeBadgeAr)}</span> ${qty(l.sizeMetersPerBoard)} م${
        l.lengthM ? ` <span class="muted">(${qty(l.lengthM)}${l.widthM ? ` × ${qty(l.widthM)}` : ""} م)</span>` : ""
      }</td>
      <td class="num">${qty(l.returnedBoards)}</td>
      <td class="num">${qty(l.returnedMeters)}</td>
      <td class="num">${num(l.unitPricePerMeter)}</td>
      <td class="num">${num(l.lineTotal)}</td>
    </tr>`,
    )
    .join("");

  const table = d.lines.length
    ? `<table>
      <thead><tr>
        <th>الكود</th><th>الصنف</th><th>المقاس</th>
        <th class="num">الألواح</th><th class="num">الأمتار</th>
        <th class="num">سعر المتر</th><th class="num">الإجمالي</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="6">الإجمالي قبل الخصم</td><td class="num">${num(d.subtotal)}</td></tr>
        ${Number(d.discountTotal) > 0 ? `<tr><td colspan="6">الخصم</td><td class="num">${num(d.discountTotal)}</td></tr>` : ""}
        ${Number(d.taxTotal) > 0 ? `<tr><td colspan="6">الضريبة</td><td class="num">${num(d.taxTotal)}</td></tr>` : ""}
        <tr><td colspan="6">إجمالي قيمة المرتجع</td><td class="num">${num(d.grandTotal)}</td></tr>
      </tfoot>
    </table>`
    : `<div class="empty">لا توجد بنود.</div>`;

  const settlement =
    d.status === "CONFIRMED"
      ? `<div class="settle">تم إضافة قيمة المرتجع (${num(d.grandTotal)}) إلى حساب العميل.</div>`
      : d.status === "CANCELLED"
        ? `<div class="settle">أُلغي هذا المرتجع${d.cancellationReason ? ` — ${esc(d.cancellationReason)}` : ""}، وعُكست كل آثاره.</div>`
        : `<div class="settle">مسودة — لم تُضف أي قيمة إلى حساب العميل ولم يتأثر المخزون بعد.</div>`;

  return shell(
    "مردود بدون فاتورة",
    meta,
    `<div class="facts">${facts.map((f) => `<div class="fact"><div class="k">${esc(f.k)}</div><div class="v">${f.v}</div></div>`).join("")}</div>
     ${table}
     ${settlement}
     ${d.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(d.notes)}</p>` : ""}`,
    d.status === "DRAFT" ? "مسودة" : d.status === "CANCELLED" ? "ملغي" : undefined,
  );
}

/** The filtered list. */
export function buildLegacyReturnListPdf(
  rows: LegacyReturnRow[],
  totals: { count: number; amount: string },
  meta: LegacyReturnPdfMeta,
): string {
  const body = rows.length
    ? `<table>
      <thead><tr>
        <th class="num">رقم المرتجع</th><th>التاريخ</th><th>العميل</th>
        <th>الفاتورة الورقية</th><th>تاريخها</th><th>المخزن</th>
        <th class="num">الأصناف</th><th class="num">القيمة</th><th>الحالة</th>
      </tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
          <td class="num">LRN-${esc(r.returnNumber)}</td>
          <td>${dateAr(r.returnDate)}</td>
          <td>${esc(r.customerNameAr)}</td>
          <td>${esc(r.paperInvoiceNumber)}</td>
          <td>${dateAr(r.paperInvoiceDate)}</td>
          <td>${esc(r.branchNameAr)}</td>
          <td class="num">${r.lineCount}</td>
          <td class="num">${num(r.grandTotal)}</td>
          <td>${STATUS_AR[r.status] ?? esc(r.status)}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
      <tfoot><tr><td colspan="7">الإجمالي (${totals.count} مستند)</td><td class="num">${num(totals.amount)}</td><td></td></tr></tfoot>
    </table>`
    : `<div class="empty">لا توجد مردودات مطابقة للفلاتر المحددة.</div>`;

  return shell("مردودات بدون فواتير", meta, body);
}
