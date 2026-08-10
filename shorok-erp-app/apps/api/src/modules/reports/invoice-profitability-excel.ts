import ExcelJS from "exceljs";

/**
 * تقرير ربحية الفواتير as a workbook.
 *
 * `exceljs` is already a dependency here — it parses the opening-balance imports
 * — so writing a workbook adds no new supply chain, only a new direction of
 * travel through a library the project already trusts.
 *
 * Two things this deliberately does NOT do:
 *
 *  - it never writes text where a number belongs. Amounts are real numeric
 *    cells with a display format, so the accountant can sum, sort and pivot
 *    them instead of re-typing them;
 *  - it never writes `0` for a cost that was never recorded. Those cells carry
 *    the string «غير متاحة». A zero would sum silently into a total and
 *    overstate profit — exactly the failure this report exists to avoid.
 *
 * Pure: data in, buffer out. No database access, so the export is provably
 * non-mutating.
 */

const MONEY = "#,##0.00";
const QTY = "#,##0.00";
const PCT = "0.00\\%";

const COVERAGE_AR: Record<string, string> = {
  COMPLETE: "مكتملة",
  PARTIAL: "غير مكتملة",
  MISSING: "غير مسجّلة",
};

interface Col {
  header: string;
  key: string;
  width: number;
  fmt?: string;
}

type Row = Record<string, unknown>;

/** `null` means the value is unknown; it must not become a zero. */
const val = (v: string | null | undefined): number | string => (v === null || v === undefined ? "غير متاحة" : Number(v));

function addSheet(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: Row[]): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
  for (const r of rows) ws.addRow(r);
  for (const c of cols) {
    if (!c.fmt) continue;
    ws.getColumn(c.key).numFmt = c.fmt;
    ws.getColumn(c.key).alignment = { horizontal: "left" };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return ws;
}

const AGG_COLS: Col[] = [
  { header: "الكود", key: "key", width: 16 },
  { header: "الاسم", key: "label", width: 30 },
  { header: "عدد الفواتير", key: "invoiceCount", width: 12 },
  { header: "الأمتار", key: "meters", width: 12, fmt: QTY },
  { header: "صافي المبيعات بدون الضريبة", key: "netSalesExVat", width: 20, fmt: MONEY },
  { header: "صافي المبيعات ذات التكلفة المكتملة", key: "costedNetSalesExVat", width: 24, fmt: MONEY },
  { header: "تكلفة البضاعة المباعة", key: "cogs", width: 18, fmt: MONEY },
  { header: "إجمالي الربح", key: "grossProfit", width: 16, fmt: MONEY },
  { header: "هامش الربح", key: "marginPct", width: 12, fmt: PCT },
  { header: "المرتجعات", key: "returnNetExVat", width: 14, fmt: MONEY },
  { header: "تكلفة المرتجع", key: "returnCogs", width: 14, fmt: MONEY },
  { header: "صافي المبيعات بعد المرتجعات", key: "finalNetSalesExVat", width: 22, fmt: MONEY },
  { header: "صافي الربح", key: "finalProfit", width: 16, fmt: MONEY },
  { header: "الهامش النهائي", key: "finalMarginPct", width: 14, fmt: PCT },
  { header: "فواتير بتكلفة غير مكتملة", key: "incompleteCostInvoiceCount", width: 20 },
];

const aggRow = (g: Record<string, string | number | null>): Row => ({
  key: g.key,
  label: g.label,
  invoiceCount: Number(g.invoiceCount),
  meters: Number(g.meters),
  netSalesExVat: Number(g.netSalesExVat),
  costedNetSalesExVat: Number(g.costedNetSalesExVat),
  cogs: Number(g.cogs),
  grossProfit: Number(g.grossProfit),
  marginPct: g.marginPct === null ? "—" : Number(g.marginPct),
  returnNetExVat: Number(g.returnNetExVat),
  returnCogs: Number(g.returnCogs),
  finalNetSalesExVat: Number(g.finalNetSalesExVat),
  finalProfit: Number(g.finalProfit),
  finalMarginPct: g.finalMarginPct === null ? "—" : Number(g.finalMarginPct),
  incompleteCostInvoiceCount: Number(g.incompleteCostInvoiceCount),
});

export async function buildInvoiceProfitabilityWorkbook(input: {
  company: string;
  printedAt: Date;
  from: string;
  to: string;
  filters: Array<{ label: string; value: string }>;
  summary: Record<string, string | number | null>;
  invoices: Array<Record<string, string | number | null>>;
  aggregates: Record<string, Array<Record<string, string | number | null>>>;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = input.company;
  wb.created = input.printedAt;

  // ── 1. ملخص ───────────────────────────────────────────────────────────────
  const s = input.summary;
  const summary = wb.addWorksheet("ملخص", { views: [{ rightToLeft: true }] });
  summary.columns = [
    { header: "البيان", key: "k", width: 40 },
    { header: "القيمة", key: "v", width: 24 },
  ];
  summary.getRow(1).font = { bold: true };

  const meta: Array<[string, string | number]> = [
    ["الشركة", input.company],
    ["التقرير", "تقرير ربحية الفواتير"],
    ["الفترة", `${input.from} — ${input.to}`],
    ["تاريخ الإصدار", input.printedAt.toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })],
    ...input.filters.map((f) => [f.label, f.value] as [string, string]),
  ];
  for (const [k, v] of meta) summary.addRow({ k, v });
  summary.addRow({});

  const figures: Array<[string, string | number, string?]> = [
    ["عدد الفواتير", Number(s.invoiceCount)],
    ["إجمالي صافي المبيعات بدون الضريبة", Number(s.netSalesExVat), MONEY],
    ["عدد الفواتير ذات التكلفة المكتملة", Number(s.costedInvoiceCount)],
    ["صافي مبيعات الفواتير ذات التكلفة المكتملة", Number(s.costedNetSalesExVat), MONEY],
    ["إجمالي تكلفة البضاعة المباعة", Number(s.historicalCogs), MONEY],
    ["إجمالي الربح", Number(s.grossProfit), MONEY],
    ["هامش الربح", s.grossMarginPct === null ? "—" : Number(s.grossMarginPct), PCT],
    ["إجمالي مردودات المبيعات المرتبطة", Number(s.linkedReturnsNetExVat), MONEY],
    ["تكلفة البضاعة المرتجعة", Number(s.linkedReturnsCogs), MONEY],
    ["صافي المبيعات بعد المرتجعات", Number(s.finalNetSalesExVat), MONEY],
    ["صافي التكلفة بعد المرتجعات", Number(s.finalCogs), MONEY],
    ["صافي الربح بعد المرتجعات", Number(s.finalGrossProfit), MONEY],
    ["هامش الربح النهائي", s.finalGrossMarginPct === null ? "—" : Number(s.finalGrossMarginPct), PCT],
    ["عدد الفواتير ذات التكلفة التاريخية غير المكتملة", Number(s.incompleteCostInvoiceCount)],
    ["صافي مبيعات الفواتير غير مكتملة التكلفة", Number(s.incompleteCostNetSales), MONEY],
  ];
  for (const [k, v, fmt] of figures) {
    const row = summary.addRow({ k, v });
    if (fmt) row.getCell("v").numFmt = fmt;
    row.getCell("v").alignment = { horizontal: "left" };
  }

  if (Number(s.incompleteCostInvoiceCount) > 0) {
    summary.addRow({});
    const note = summary.addRow({
      k: "تنبيه",
      v: "أرقام التكلفة والربح تخص الفواتير ذات التكلفة التاريخية المكتملة فقط. الفواتير التي لم تُسجَّل تكلفتها وقت البيع مستبعدة من الربح ولا تظهر بتكلفة صفرية.",
    });
    note.font = { bold: true };
    note.alignment = { wrapText: true, vertical: "top" };
  }

  // ── 2. الفواتير ───────────────────────────────────────────────────────────
  addSheet(
    wb,
    "الفواتير",
    [
      { header: "رقم الفاتورة", key: "invoiceNumber", width: 14 },
      { header: "التاريخ", key: "invoiceDate", width: 12 },
      { header: "العميل", key: "customer", width: 30 },
      { header: "الفرع", key: "branchName", width: 16 },
      { header: "مندوب المبيعات", key: "rep", width: 18 },
      { header: "إجمالي البيع قبل الخصم", key: "salesBeforeDiscount", width: 18, fmt: MONEY },
      { header: "الخصم", key: "discount", width: 12, fmt: MONEY },
      { header: "صافي المبيعات بدون الضريبة", key: "netSalesExVat", width: 20, fmt: MONEY },
      { header: "الضريبة", key: "tax", width: 12, fmt: MONEY },
      { header: "الإجمالي شامل الضريبة", key: "grandTotal", width: 18, fmt: MONEY },
      { header: "التكلفة التاريخية", key: "cogs", width: 16, fmt: MONEY },
      { header: "الربح قبل المرتجعات", key: "grossProfit", width: 16, fmt: MONEY },
      { header: "هامش الربح", key: "marginPct", width: 12, fmt: PCT },
      { header: "قيمة المرتجعات المؤكدة", key: "returnNetExVat", width: 18, fmt: MONEY },
      { header: "تكلفة المرتجع", key: "returnCogs", width: 14, fmt: MONEY },
      { header: "صافي المبيعات بعد المرتجعات", key: "finalNetSalesExVat", width: 22, fmt: MONEY },
      { header: "صافي التكلفة بعد المرتجعات", key: "finalCogs", width: 22, fmt: MONEY },
      { header: "صافي ربح الفاتورة", key: "finalProfit", width: 16, fmt: MONEY },
      { header: "هامش الربح النهائي", key: "finalMarginPct", width: 16, fmt: PCT },
      { header: "حالة اكتمال التكلفة", key: "coverage", width: 16 },
    ],
    input.invoices.map((r) => ({
      invoiceNumber: String(r.invoiceNumber),
      invoiceDate: String(r.invoiceDate),
      customer: r.customerCode ? `${r.customerCode} — ${r.customerName ?? ""}` : (r.customerName ?? ""),
      branchName: r.branchName ?? "",
      rep: r.salesRepresentativeName ?? "—",
      salesBeforeDiscount: Number(r.salesBeforeDiscount),
      discount: Number(r.discount),
      netSalesExVat: Number(r.netSalesExVat),
      tax: Number(r.tax),
      grandTotal: Number(r.grandTotal),
      cogs: val(r.cogs as string | null),
      grossProfit: val(r.grossProfit as string | null),
      marginPct: r.marginPct === null ? "—" : Number(r.marginPct),
      returnNetExVat: Number(r.returnNetExVat),
      returnCogs: val(r.returnCogs as string | null),
      finalNetSalesExVat: Number(r.finalNetSalesExVat),
      finalCogs: val(r.finalCogs as string | null),
      finalProfit: val(r.finalProfit as string | null),
      finalMarginPct: r.finalMarginPct === null ? "—" : Number(r.finalMarginPct),
      coverage: COVERAGE_AR[String(r.costCoverage)] ?? String(r.costCoverage),
    })),
  );

  // ── 3-6. الأصناف / العملاء / الفروع / مندوبي المبيعات ─────────────────────
  const tabs: Array<[string, string]> = [
    ["الأصناف", "product"],
    ["العملاء", "customer"],
    ["الفروع", "branch"],
    ["مندوبي المبيعات", "representative"],
  ];
  for (const [sheetName, dim] of tabs) {
    const rows = input.aggregates[dim] ?? [];
    addSheet(wb, sheetName, AGG_COLS, rows.map(aggRow));
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
