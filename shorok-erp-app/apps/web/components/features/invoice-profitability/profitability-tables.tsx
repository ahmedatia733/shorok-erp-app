"use client";

import type { AppLocale } from "../../../i18n";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Table, TBody, TD, TH, THead, TR } from "../../ui/table";
import { formatCurrency, formatDate } from "../../../lib/format";
import type {
  CostCoverage,
  ProfitabilityGroup,
  ProfitabilityInvoice,
} from "../../../lib/invoice-profitability-client";

/**
 * The tables behind تقرير ربحية الفواتير.
 *
 * The rule that shapes all of them: a value the ERP never recorded is rendered
 * as «غير متاحة», never as `0.00`. A zero cost silently becomes a 100% margin,
 * and a margin that looks precise gets believed.
 */

export const COVERAGE_AR: Record<CostCoverage, string> = {
  COMPLETE: "مكتملة",
  PARTIAL: "غير مكتملة",
  MISSING: "غير مسجّلة",
};

/** An amount, or an honest gap where the ERP has no cost to show. */
export function Money({ value, locale, bold }: { value: string | null; locale: AppLocale; bold?: boolean }) {
  if (value === null) return <span className="text-warning italic">غير متاحة</span>;
  const negative = Number(value) < 0;
  return (
    <span dir="ltr" className={`tabular-nums ${negative ? "text-danger" : ""} ${bold ? "font-semibold" : ""}`}>
      {formatCurrency(value, locale)}
    </span>
  );
}

export function Pct({ value }: { value: string | null }) {
  if (value === null) return <span className="text-textSecondary">—</span>;
  const n = Number(value);
  return (
    <span dir="ltr" className={`tabular-nums ${n < 0 ? "text-danger" : ""}`}>
      {n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%
    </span>
  );
}

export function CoverageBadge({ coverage, missing }: { coverage: CostCoverage; missing: number }) {
  if (coverage === "COMPLETE") return <Badge variant="success">{COVERAGE_AR.COMPLETE}</Badge>;
  return (
    <Badge variant="warning" title={`${missing} بند بلا تكلفة مسجّلة`}>
      {COVERAGE_AR[coverage]}
    </Badge>
  );
}

// ── حسب الفواتير ────────────────────────────────────────────────────────────

export function InvoiceProfitTable({
  rows,
  locale,
  onOpen,
  onPdf,
  pdfBusyId,
}: {
  rows: ProfitabilityInvoice[];
  locale: AppLocale;
  onOpen: (r: ProfitabilityInvoice) => void;
  onPdf: (r: ProfitabilityInvoice) => void;
  pdfBusyId: string | null;
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TR>
            <TH>رقم الفاتورة</TH>
            <TH>التاريخ</TH>
            <TH>العميل</TH>
            <TH>الفرع</TH>
            <TH>المندوب</TH>
            <TH>قبل الخصم</TH>
            <TH>الخصم</TH>
            <TH>صافي المبيعات بدون الضريبة</TH>
            <TH>الضريبة</TH>
            <TH>الإجمالي</TH>
            <TH>التكلفة التاريخية</TH>
            <TH>الربح</TH>
            <TH>الهامش</TH>
            <TH>المرتجعات</TH>
            <TH>تكلفة المرتجع</TH>
            <TH>صافي المبيعات بعد المرتجع</TH>
            <TH>صافي الربح</TH>
            <TH>الهامش النهائي</TH>
            <TH>اكتمال التكلفة</TH>
            <TH>الإجراءات</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.id} data-testid={`ip-row-${r.invoiceNumber}`}>
              <TD className="font-mono">
                {r.invoiceNumber}
                {r.revisionNumber > 1 && (
                  <Badge variant="neutral" title="فاتورة مُعدّلة — القيم المعروضة هي الحالة الاقتصادية الحالية">
                    مراجعة {r.revisionNumber}
                  </Badge>
                )}
              </TD>
              <TD>{formatDate(r.invoiceDate, locale)}</TD>
              <TD>{r.customerCode ? `${r.customerCode} — ${r.customerName ?? ""}` : r.customerName ?? "—"}</TD>
              <TD>{r.branchName ?? "—"}</TD>
              <TD>{r.salesRepresentativeName ?? "—"}</TD>
              <TD dir="ltr"><Money value={r.salesBeforeDiscount} locale={locale} /></TD>
              <TD dir="ltr"><Money value={r.discount} locale={locale} /></TD>
              <TD dir="ltr"><Money value={r.netSalesExVat} locale={locale} /></TD>
              <TD dir="ltr"><Money value={r.tax} locale={locale} /></TD>
              <TD dir="ltr"><Money value={r.grandTotal} locale={locale} /></TD>
              <TD dir="ltr"><Money value={r.cogs} locale={locale} /></TD>
              <TD dir="ltr"><Money value={r.grossProfit} locale={locale} bold /></TD>
              <TD dir="ltr"><Pct value={r.marginPct} /></TD>
              <TD dir="ltr"><Money value={r.returnNetExVat} locale={locale} /></TD>
              <TD dir="ltr"><Money value={r.returnCogs} locale={locale} /></TD>
              <TD dir="ltr"><Money value={r.finalNetSalesExVat} locale={locale} /></TD>
              <TD dir="ltr"><Money value={r.finalProfit} locale={locale} bold /></TD>
              <TD dir="ltr"><Pct value={r.finalMarginPct} /></TD>
              <TD><CoverageBadge coverage={r.costCoverage} missing={r.linesMissingCost} /></TD>
              <TD>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" data-testid={`ip-open-${r.invoiceNumber}`} onClick={() => onOpen(r)}>
                    عرض التفاصيل
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pdfBusyId === r.id}
                    data-testid={`ip-pdf-${r.invoiceNumber}`}
                    onClick={() => onPdf(r)}
                  >
                    {pdfBusyId === r.id ? "…" : "PDF"}
                  </Button>
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

// ── الأصناف / العملاء / الفروع / مندوبي المبيعات ────────────────────────────

export function AggregateTable({
  rows,
  locale,
  keyHeader,
  labelHeader,
}: {
  rows: ProfitabilityGroup[];
  locale: AppLocale;
  keyHeader: string;
  labelHeader: string;
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TR>
            <TH>{keyHeader}</TH>
            <TH>{labelHeader}</TH>
            <TH>عدد الفواتير</TH>
            <TH>الأمتار</TH>
            <TH>صافي المبيعات بدون الضريبة</TH>
            <TH>التكلفة التاريخية</TH>
            <TH>الربح</TH>
            <TH>الهامش</TH>
            <TH>المرتجعات</TH>
            <TH>صافي المبيعات بعد المرتجع</TH>
            <TH>صافي الربح</TH>
            <TH>الهامش النهائي</TH>
            <TH>تكلفة غير مكتملة</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((g) => (
            <TR key={g.key || g.label} data-testid={`ip-agg-${g.key || g.label}`}>
              <TD className="font-mono">{g.key || "—"}</TD>
              <TD>{g.label}</TD>
              <TD dir="ltr">{g.invoiceCount}</TD>
              <TD dir="ltr">{Number(g.meters).toLocaleString("ar-EG", { maximumFractionDigits: 2 })}</TD>
              <TD dir="ltr"><Money value={g.netSalesExVat} locale={locale} /></TD>
              <TD dir="ltr"><Money value={g.cogs} locale={locale} /></TD>
              <TD dir="ltr"><Money value={g.grossProfit} locale={locale} bold /></TD>
              <TD dir="ltr"><Pct value={g.marginPct} /></TD>
              <TD dir="ltr"><Money value={g.returnNetExVat} locale={locale} /></TD>
              <TD dir="ltr"><Money value={g.finalNetSalesExVat} locale={locale} /></TD>
              <TD dir="ltr"><Money value={g.finalProfit} locale={locale} bold /></TD>
              <TD dir="ltr"><Pct value={g.finalMarginPct} /></TD>
              <TD dir="ltr">
                {g.incompleteCostInvoiceCount > 0 ? (
                  <Badge variant="warning">{g.incompleteCostInvoiceCount}</Badge>
                ) : (
                  <span className="text-textSecondary">—</span>
                )}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
