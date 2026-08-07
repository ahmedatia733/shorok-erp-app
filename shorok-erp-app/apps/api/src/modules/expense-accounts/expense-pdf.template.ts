import type {
  ExpenseAccountDetail,
  ExpenseDashboard,
  ExpenseItemsResponse,
  ExpenseMovementsResponse,
} from "@shorok/shared";
import { cairoFontFaceCss } from "../invoice-pdf/fonts";

/**
 * The printable face of the Expenses area.
 *
 * Four reports, one shell. Arabic comes out connected and right-to-left because
 * Cairo is embedded as a base64 @font-face by `cairoFontFaceCss()` and real
 * Chromium does the shaping — the same path the invoice and return PDFs already
 * take in production, so there is one Arabic rendering story in this codebase
 * rather than two.
 *
 * These builders are pure: data in, HTML string out. Nothing here reads or
 * writes the database, which is what lets the export be proven non-mutating.
 */

const esc = (s: string | null | undefined): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Arabic-Indic grouping, matching how the screens print money. */
const num = (v: string | number): string => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return esc(String(v));
  return n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const dateAr = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleDateString("ar-EG", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" });
};

export interface ExpensePdfMeta {
  companyName: string;
  /** Already-formatted generation timestamp. */
  printedAt: string;
  /** The filters that produced this data, as label/value pairs. */
  filters: Array<{ label: string; value: string }>;
}

/**
 * The page shell.
 *
 * `@page` sets the paper; the renderer supplies the running "— n / m —" footer,
 * so page numbering comes from Chromium rather than from anything counted here.
 * `thead { display: table-header-group }` repeats the header on every page, and
 * `tr { break-inside: avoid }` is what stops a row being sliced across a page
 * break — the two rules that make a long Arabic table readable on paper.
 */
function shell(title: string, meta: ExpensePdfMeta, body: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
${cairoFontFaceCss()}
@page { size: A4; margin: 14mm 12mm 18mm 12mm; }
* { box-sizing: border-box; }
body {
  font-family: 'Cairo', sans-serif; direction: rtl; text-align: right;
  color: #1f2937; font-size: 11px; margin: 0; padding: 0; background: #fff;
}
.head { border-bottom: 2px solid #111827; padding-bottom: 8px; margin-bottom: 12px; }
.company { font-size: 15px; font-weight: 700; }
.title { font-size: 18px; font-weight: 700; margin-top: 2px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-top: 6px; color: #4b5563; font-size: 10px; }
.meta b { color: #111827; font-weight: 700; }
h2 { font-size: 13px; margin: 14px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #d1d5db; }
table { width: 100%; border-collapse: collapse; margin-top: 4px; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { border: 1px solid #d1d5db; padding: 4px 6px; text-align: right; vertical-align: top; }
th { background: #f3f4f6; font-weight: 700; font-size: 10px; }
td.num, th.num { text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap; }
tbody tr:nth-child(even) { background: #fafafa; }
tfoot td { background: #f3f4f6; font-weight: 700; }
.cards { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.card { flex: 1 1 30%; min-width: 150px; border: 1px solid #d1d5db; border-radius: 5px; padding: 8px 10px; }
.card .k { color: #6b7280; font-size: 10px; }
.card .v { font-size: 15px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
.muted { color: #6b7280; }
.neg { color: #b91c1c; }
.bar-row { display: flex; align-items: center; gap: 6px; margin: 3px 0; break-inside: avoid; }
.bar-label { width: 34%; font-size: 10px; }
.bar-track { flex: 1; background: #f3f4f6; border: 1px solid #e5e7eb; height: 12px; position: relative; }
.bar-fill { position: absolute; inset-inline-start: 0; top: 0; bottom: 0; background: #6b7280; }
.bar-val { width: 22%; text-align: left; font-size: 10px; font-variant-numeric: tabular-nums; }
.note { margin-top: 10px; font-size: 9px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 5px; }
.empty { padding: 16px; text-align: center; color: #6b7280; border: 1px dashed #d1d5db; }
</style>
</head>
<body>
  <div class="head">
    <div class="company">${esc(meta.companyName)}</div>
    <div class="title">${esc(title)}</div>
    <div class="meta">
      <span><b>تاريخ الإصدار:</b> ${esc(meta.printedAt)}</span>
      ${meta.filters.map((f) => `<span><b>${esc(f.label)}:</b> ${esc(f.value)}</span>`).join("")}
    </div>
  </div>
  ${body}
  <div class="note">
    القيم محسوبة من دفتر الأستاذ العام (القيود المرحّلة غير المعكوسة) بنفس قواعد قائمة الدخل.
    المبالغ بالجنيه المصري وتشمل جميع الفروع.
  </div>
</body>
</html>`;
}

/** «مصروف» is a debit; a credit balance is shown as a negative, not hidden. */
const money = (v: string): string =>
  Number(v) < 0 ? `<span class="neg">${num(v)}</span>` : num(v);

// ── A. نظرة عامة ───────────────────────────────────────────────────────────

export function buildDashboardPdf(data: ExpenseDashboard, meta: ExpensePdfMeta): string {
  const cards = [
    { k: "إجمالي مصروفات الفترة", v: num(data.periodTotal) },
    { k: "مصروفات الشهر حتى اليوم", v: num(data.monthToDateTotal) },
    { k: "مصروفات اليوم", v: num(data.todayTotal) },
    { k: "عدد بنود المصروفات النشطة", v: String(data.activeItemCount) },
    { k: "أعلى بند مصروف", v: data.topItem ? `${esc(data.topItem.nameAr)} — ${num(data.topItem.amount)}` : "—" },
    {
      k: "مقارنة بالفترة السابقة",
      v:
        `${num(data.changeAmount)}` +
        (data.changePercent === null ? "" : ` (${num(data.changePercent)}%)`),
    },
  ];

  const maxMonth = data.byMonth.reduce((m, p) => Math.max(m, Math.abs(Number(p.amount))), 0);

  const byMonth = data.byMonth.length
    ? data.byMonth
        .map(
          (p) => `<div class="bar-row">
        <span class="bar-label">${esc(p.month)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${
          maxMonth ? Math.round((Math.abs(Number(p.amount)) / maxMonth) * 100) : 0
        }%"></span></span>
        <span class="bar-val">${num(p.amount)}</span>
      </div>`,
        )
        .join("")
    : `<div class="empty">لا توجد حركة في الفترة المحددة.</div>`;

  const byItem = data.byItem.length
    ? `<table>
      <thead><tr><th>الكود</th><th>بند المصروف</th><th class="num">المبلغ</th><th class="num">النسبة</th></tr></thead>
      <tbody>
        ${data.byItem
          .map(
            (p) => `<tr>
          <td>${esc(p.code)}</td><td>${esc(p.nameAr)}</td>
          <td class="num">${money(p.amount)}</td>
          <td class="num">${p.percent ? `${num(p.percent)}%` : "—"}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
      <tfoot><tr><td colspan="2">الإجمالي</td><td class="num">${money(data.periodTotal)}</td><td class="num">100%</td></tr></tfoot>
    </table>`
    : `<div class="empty">لا توجد بنود بها حركة في الفترة المحددة.</div>`;

  return shell(
    "تقرير المصروفات",
    meta,
    `<div class="cards">
      ${cards.map((c) => `<div class="card"><div class="k">${esc(c.k)}</div><div class="v">${c.v}</div></div>`).join("")}
    </div>
    <h2>المصروفات حسب الشهر</h2>
    ${byMonth}
    <h2>توزيع المصروفات حسب البند</h2>
    ${byItem}`,
  );
}

// ── B. بنود المصروفات ──────────────────────────────────────────────────────

export function buildItemsPdf(data: ExpenseItemsResponse, meta: ExpensePdfMeta): string {
  const body = data.items.length
    ? `<table>
      <thead>
        <tr>
          <th>الكود</th><th>اسم بند المصروف</th><th>الحالة</th>
          <th class="num">مصروف الفترة</th><th class="num">الإجمالي</th><th>آخر حركة</th>
        </tr>
      </thead>
      <tbody>
        ${data.items
          .map(
            (i) => `<tr>
          <td>${esc(i.code)}</td>
          <td>${esc(i.nameAr)}</td>
          <td>${i.active ? "نشط" : "غير نشط"}</td>
          <td class="num">${money(i.periodAmount)}</td>
          <td class="num">${money(i.totalAmount)}</td>
          <td>${dateAr(i.lastMovementDate)}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="3">الإجمالي (${data.items.length} بند)</td>
          <td class="num">${money(data.periodTotal)}</td>
          <td class="num">${money(data.grandTotal)}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>`
    : `<div class="empty">لا توجد بنود مصروفات مطابقة.</div>`;

  return shell("بنود المصروفات", meta, body);
}

// ── C. حركة المصروفات ──────────────────────────────────────────────────────

const counterText = (m: ExpenseMovementsResponse["rows"][number]): string =>
  m.counterAccounts.length ? m.counterAccounts.map((c) => `${c.nameAr} (${c.code})`).join("، ") : "—";

export function buildMovementsPdf(data: ExpenseMovementsResponse, meta: ExpensePdfMeta): string {
  const body = data.rows.length
    ? `<table>
      <thead>
        <tr>
          <th>التاريخ</th><th>بند المصروف</th><th class="num">المبلغ</th>
          <th>البيان</th><th class="num">رقم القيد</th><th>الحساب المقابل</th><th>الفرع</th>
        </tr>
      </thead>
      <tbody>
        ${data.rows
          .map(
            (m) => `<tr>
          <td>${dateAr(m.entryDate)}</td>
          <td>${esc(m.accountNameAr)}<div class="muted">${esc(m.accountCode)}</div></td>
          <td class="num">${money(m.amount)}</td>
          <td>${esc(m.note || m.entryDescription)}</td>
          <td class="num">${esc(m.entryNumber)}</td>
          <td>${esc(counterText(m))}</td>
          <td>${esc(m.branchNameAr ?? "—")}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="2">الإجمالي (${data.totalCount} حركة)</td>
          <td class="num">${money(data.totalAmount)}</td>
          <td colspan="4"></td>
        </tr>
      </tfoot>
    </table>`
    : `<div class="empty">لا توجد حركات مطابقة للفلاتر المحددة.</div>`;

  return shell("حركة المصروفات", meta, body);
}

// ── D. تفاصيل بند مصروف ────────────────────────────────────────────────────

export function buildDetailPdf(data: ExpenseAccountDetail, meta: ExpensePdfMeta): string {
  const cards = [
    { k: "الكود", v: esc(data.code) },
    { k: "الحالة", v: data.active ? "نشط" : "غير نشط" },
    { k: "مصروف الفترة", v: num(data.periodAmount) },
    { k: "إجمالي المصروف", v: num(data.totalAmount) },
    { k: "عدد الحركات في الفترة", v: String(data.periodMovementCount) },
    { k: "آخر حركة", v: dateAr(data.lastMovementDate) },
  ];

  const table = data.movements.length
    ? `<table>
      <thead>
        <tr><th>التاريخ</th><th class="num">رقم القيد</th><th>البيان</th><th>الحساب المقابل</th><th class="num">المبلغ</th></tr>
      </thead>
      <tbody>
        ${data.movements
          .map(
            (m) => `<tr>
          <td>${dateAr(m.entryDate)}</td>
          <td class="num">${esc(m.entryNumber)}</td>
          <td>${esc(m.note || m.entryDescription)}</td>
          <td>${esc(counterText(m))}</td>
          <td class="num">${money(m.amount)}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
      <tfoot><tr><td colspan="4">إجمالي الفترة</td><td class="num">${money(data.periodAmount)}</td></tr></tfoot>
    </table>`
    : `<div class="empty">لا توجد حركات في الفترة المحددة.</div>`;

  return shell(
    `بند مصروف — ${data.nameAr}`,
    meta,
    `<div class="cards">
      ${cards.map((c) => `<div class="card"><div class="k">${esc(c.k)}</div><div class="v">${c.v}</div></div>`).join("")}
    </div>
    <h2>حركة البند</h2>
    ${table}`,
  );
}
