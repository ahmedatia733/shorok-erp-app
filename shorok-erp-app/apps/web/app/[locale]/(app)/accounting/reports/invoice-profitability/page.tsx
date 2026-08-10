"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody } from "../../../../../../components/ui/card";
import { EmptyState } from "../../../../../../components/ui/empty-state";
import { Input } from "../../../../../../components/ui/input";
import { Label } from "../../../../../../components/ui/label";
import { SearchableSelect } from "../../../../../../components/ui/searchable-select";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import { ApiClientError } from "../../../../../../lib/api-client";
import { formatCurrency } from "../../../../../../lib/format";
import { toCustomerOptions } from "../../../../../../lib/customer-options";
import { listCustomers, type CustomerRow } from "../../../../../../lib/customers-client";
import { listBranches, type BranchSummary } from "../../../../../../lib/inventory-client";
import { listRepresentatives, type SalesRepresentative } from "../../../../../../lib/sales-representatives-client";
import {
  downloadInvoiceProfitPdf,
  downloadProfitabilityExcel,
  downloadProfitabilityPdf,
  getProfitabilityAggregates,
  getProfitabilityDetail,
  getProfitabilityReport,
  type ProfitabilityAggregates,
  type ProfitabilityDetail,
  type ProfitabilityFilters,
  type ProfitabilityInvoice,
  type ProfitabilityReport,
} from "../../../../../../lib/invoice-profitability-client";
import {
  AggregateTable,
  InvoiceProfitTable,
  Money,
  Pct,
} from "../../../../../../components/features/invoice-profitability/profitability-tables";
import { InvoiceProfitDetail } from "../../../../../../components/features/invoice-profitability/invoice-profit-detail";

/** Defaults to the current calendar month — the question people actually ask. */
function currentMonth(): { from: string; to: string } {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
    to: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))),
  };
}

type Tab = "invoices" | "products" | "customers" | "branches" | "representatives";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "invoices", label: "حسب الفواتير" },
  { id: "products", label: "حسب الأصناف" },
  { id: "customers", label: "حسب العملاء" },
  { id: "branches", label: "حسب الفروع" },
  { id: "representatives", label: "حسب مندوبي المبيعات" },
];

const PAGE_SIZE = 50;

/**
 * تقرير ربحية الفواتير.
 *
 * Read-only throughout: it asks the server what each sale earned and draws the
 * answer. Nothing on this screen writes.
 *
 * The report answers «صافي المبيعات بدون الضريبة − تكلفة البضاعة المباعة».
 * VAT is not profit and operating expenses are not allocated to invoices, so
 * this is gross invoice profitability — not company net profit.
 *
 * Where the ERP never recorded a cost, the cost, profit and margin read
 * «غير متاحة». Showing zero there would print a 100% margin and be believed.
 */
export default function InvoiceProfitabilityPage() {
  const locale = useLocale() as AppLocale;

  const [range, setRange] = useState(currentMonth());
  const [branchId, setBranchId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [repId, setRepId] = useState("");
  const [productCode, setProductCode] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [coverage, setCoverage] = useState<"ALL" | "COMPLETE" | "INCOMPLETE">("ALL");
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<Tab>("invoices");

  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [reps, setReps] = useState<SalesRepresentative[]>([]);

  const [report, setReport] = useState<ProfitabilityReport | null>(null);
  const [aggregates, setAggregates] = useState<ProfitabilityAggregates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState<"pdf" | "excel" | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<ProfitabilityDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null);

  // Applied filters — the ones the last تحديث actually sent. Editing a filter
  // input must not silently change the numbers already on screen.
  const [applied, setApplied] = useState<ProfitabilityFilters>({ ...currentMonth() });

  const customerOptions = useMemo(() => toCustomerOptions(customers), [customers]);

  useEffect(() => {
    void (async () => {
      const [b, c, r] = await Promise.all([
        listBranches().catch(() => []),
        listCustomers().catch(() => []),
        listRepresentatives({ status: "all" }).catch(() => []),
      ]);
      setBranches(b);
      setCustomers(c);
      setReps(r);
    })();
  }, []);

  // A newer request must always win. Without this, typing quickly into a filter
  // can let a slower earlier response overwrite a newer one.
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async (filters: ProfitabilityFilters) => {
    requestRef.current?.abort();
    const ctl = new AbortController();
    requestRef.current = ctl;

    setLoading(true);
    setError(null);
    try {
      const [rep, agg] = await Promise.all([
        getProfitabilityReport({ ...filters, pageSize: PAGE_SIZE }, ctl.signal),
        getProfitabilityAggregates(filters, ctl.signal),
      ]);
      if (ctl.signal.aborted) return;
      setReport(rep);
      setAggregates(agg);
    } catch (e) {
      if (ctl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر تحميل التقرير.");
    } finally {
      if (!ctl.signal.aborted) setLoading(false);
    }
  }, [locale]);

  useEffect(() => {
    void load(applied);
  }, [applied, load]);

  const apply = () => {
    setPage(1);
    setApplied({
      from: range.from,
      to: range.to,
      branchId: branchId || undefined,
      customerId: customerId || undefined,
      salesRepresentativeId: repId || undefined,
      productCode: productCode.trim() || undefined,
      invoiceNumber: invoiceNumber.trim() || undefined,
      costCoverage: coverage,
      page: 1,
    });
  };

  const clear = () => {
    const m = currentMonth();
    setRange(m);
    setBranchId("");
    setCustomerId("");
    setRepId("");
    setProductCode("");
    setInvoiceNumber("");
    setCoverage("ALL");
    setPage(1);
    setApplied({ ...m });
  };

  const goToPage = (next: number) => {
    setPage(next);
    setApplied((a) => ({ ...a, page: next }));
  };

  const openDetail = async (row: ProfitabilityInvoice) => {
    setDetailOpen(true);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setDetail(await getProfitabilityDetail(row.id, applied));
    } catch (e) {
      setDetailError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر تحميل تفاصيل الفاتورة.");
    } finally {
      setDetailLoading(false);
    }
  };

  const savePdf = async (kind: "pdf" | "excel") => {
    setExportBusy(kind);
    setError(null);
    try {
      if (kind === "pdf") await downloadProfitabilityPdf(applied, locale);
      else await downloadProfitabilityExcel(applied, locale);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر إنشاء الملف.");
    } finally {
      setExportBusy(null);
    }
  };

  const saveInvoicePdf = async (row: ProfitabilityInvoice) => {
    setPdfBusyId(row.id);
    try {
      await downloadInvoiceProfitPdf(row.id, row.invoiceNumber, applied, locale);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر إنشاء الملف.");
    } finally {
      setPdfBusyId(null);
    }
  };

  const s = report?.summary;
  const money = (v: string) => formatCurrency(v, locale);

  // Insights, computed from what is already on screen — no extra request.
  const insights = useMemo(() => {
    const priced = (report?.invoices ?? []).filter((r) => r.finalProfit !== null);
    const byProfit = [...priced].sort((a, b) => Number(b.finalProfit) - Number(a.finalProfit));
    const products = [...(aggregates?.product ?? [])].sort((a, b) => Number(b.finalProfit) - Number(a.finalProfit));
    const byMargin = [...(aggregates?.product ?? [])]
      .filter((g) => g.finalMarginPct !== null)
      .sort((a, b) => Number(a.finalMarginPct) - Number(b.finalMarginPct));
    const customersTop = [...(aggregates?.customer ?? [])].sort((a, b) => Number(b.finalProfit) - Number(a.finalProfit));
    return {
      topInvoices: byProfit.slice(0, 5),
      bottomInvoices: byProfit.slice(-5).reverse(),
      topProducts: products.slice(0, 5),
      worstMarginProducts: byMargin.slice(0, 5),
      topCustomers: customersTop.slice(0, 5),
    };
  }, [report, aggregates]);

  const totalPages = report ? Math.max(1, Math.ceil(report.totalInvoices / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">تقرير ربحية الفواتير</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            data-testid="ip-save-pdf"
            disabled={exportBusy !== null || loading}
            onClick={() => void savePdf("pdf")}
          >
            {exportBusy === "pdf" ? "جارٍ إنشاء الملف…" : "حفظ PDF"}
          </Button>
          <Button
            variant="secondary"
            data-testid="ip-export-excel"
            disabled={exportBusy !== null || loading}
            onClick={() => void savePdf("excel")}
          >
            {exportBusy === "excel" ? "جارٍ التصدير…" : "تصدير Excel"}
          </Button>
        </div>
      </div>

      <p className="text-sm text-textSecondary">
        صافي المبيعات بدون الضريبة ناقص تكلفة البضاعة المباعة التاريخية المسجّلة وقت البيع. الضريبة ليست ربحاً،
        والمصروفات التشغيلية العامة لا تُوزَّع على الفواتير.
      </p>

      {/* ── الفلاتر ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label htmlFor="ip-from">من تاريخ</Label>
            <Input
              id="ip-from"
              data-testid="ip-from"
              type="date"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="ip-to">إلى تاريخ</Label>
            <Input
              id="ip-to"
              data-testid="ip-to"
              type="date"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="ip-branch">الفرع</Label>
            <select
              id="ip-branch"
              data-testid="ip-branch"
              className="h-9 w-full rounded border border-border bg-background px-2 text-sm"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">كل الفروع</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.nameAr}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="ip-customer">العميل</Label>
            <SearchableSelect
              id="ip-customer"
              testId="ip-customer"
              value={customerId}
              onChange={setCustomerId}
              options={customerOptions}
              placeholder="كل العملاء — بحث بالكود أو الاسم"
              emptyText="لا يوجد عميل مطابق"
              clearable
            />
          </div>
          <div>
            <Label htmlFor="ip-rep">مندوب المبيعات</Label>
            <select
              id="ip-rep"
              data-testid="ip-rep"
              className="h-9 w-full rounded border border-border bg-background px-2 text-sm"
              value={repId}
              onChange={(e) => setRepId(e.target.value)}
            >
              <option value="">كل المندوبين</option>
              {reps.map((r) => (
                <option key={r.id} value={r.id}>{r.nameAr}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="ip-product">كود الصنف</Label>
            <Input
              id="ip-product"
              data-testid="ip-product"
              value={productCode}
              onChange={(e) => setProductCode(e.target.value)}
              placeholder="مثال: D1"
            />
          </div>
          <div>
            <Label htmlFor="ip-invoice">رقم الفاتورة</Label>
            <Input
              id="ip-invoice"
              data-testid="ip-invoice"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="ip-coverage">اكتمال التكلفة</Label>
            <select
              id="ip-coverage"
              data-testid="ip-coverage"
              className="h-9 w-full rounded border border-border bg-background px-2 text-sm"
              value={coverage}
              onChange={(e) => setCoverage(e.target.value as typeof coverage)}
            >
              <option value="ALL">الكل</option>
              <option value="COMPLETE">تكلفة مكتملة فقط</option>
              <option value="INCOMPLETE">تكلفة غير مكتملة فقط</option>
            </select>
          </div>
          <div className="flex items-end gap-2 lg:col-span-4">
            <Button data-testid="ip-refresh" onClick={apply} disabled={loading}>
              {loading ? "جارٍ التحديث…" : "تحديث"}
            </Button>
            <Button variant="ghost" data-testid="ip-clear" onClick={clear}>مسح الفلاتر</Button>
          </div>
        </CardBody>
      </Card>

      {error && <Alert variant="error">{error}</Alert>}

      {loading && !report && <Skeleton className="h-64 w-full" />}

      {s && (
        <>
          {/* ── بطاقات الملخص ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4" data-testid="ip-summary">
            {[
              { k: "عدد الفواتير", v: String(s.invoiceCount) },
              { k: "إجمالي صافي المبيعات بدون الضريبة", v: money(s.netSalesExVat) },
              { k: "إجمالي تكلفة البضاعة المباعة", v: money(s.historicalCogs) },
              { k: "إجمالي الربح", v: money(s.grossProfit) },
              { k: "هامش الربح", v: <Pct value={s.grossMarginPct} /> },
              { k: "إجمالي مردودات المبيعات المرتبطة", v: money(s.linkedReturnsNetExVat) },
              { k: "تكلفة البضاعة المرتجعة", v: money(s.linkedReturnsCogs) },
              { k: "صافي المبيعات بعد المرتجعات", v: money(s.finalNetSalesExVat) },
              { k: "صافي التكلفة بعد المرتجعات", v: money(s.finalCogs) },
              { k: "صافي الربح بعد المرتجعات", v: money(s.finalGrossProfit) },
              { k: "هامش الربح النهائي", v: <Pct value={s.finalGrossMarginPct} /> },
              {
                k: "فواتير بتكلفة تاريخية غير مكتملة",
                v: String(s.incompleteCostInvoiceCount),
                warn: s.incompleteCostInvoiceCount > 0,
              },
            ].map((c) => (
              <Card key={c.k} className={c.warn ? "border-warning" : undefined}>
                <CardBody>
                  <div className="text-xs text-textSecondary">{c.k}</div>
                  <div className="mt-1 text-lg font-bold tabular-nums" dir="ltr">{c.v}</div>
                </CardBody>
              </Card>
            ))}
          </div>

          {s.incompleteCostInvoiceCount > 0 && (
            <Alert variant="warning" data-testid="ip-incomplete-warning">
              أرقام التكلفة والربح أعلاه هي <b>ربحية مؤكدة للفواتير ذات بيانات التكلفة المكتملة</b>:{" "}
              {s.costedInvoiceCount} فاتورة بصافي مبيعات {money(s.costedNetSalesExVat)}.
              <br />
              <b>فواتير تحتاج بيانات تكلفة تاريخية: {s.incompleteCostInvoiceCount}</b>، بصافي مبيعات{" "}
              {money(s.incompleteCostNetSales)}. تكلفة هذه الفواتير لم تُسجَّل وقت البيع ولا يمكن استنتاجها،
              ولذلك استُبعدت من الربح بدلاً من احتسابها بصفر.
            </Alert>
          )}

          {/* ── التبويبات ──────────────────────────────────────────────────── */}
          <div className="flex flex-wrap gap-1 border-b border-border" role="tablist">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                type="button"
                role="tab"
                aria-selected={tab === tb.id}
                data-testid={`ip-tab-${tb.id}`}
                onClick={() => setTab(tb.id)}
                className={
                  "rounded-t px-3 py-2 text-sm " +
                  (tab === tb.id ? "border-b-2 border-primary font-semibold text-primary" : "text-textSecondary hover:text-textPrimary")
                }
              >
                {tb.label}
              </button>
            ))}
          </div>

          <Card>
            <CardBody>
              {tab === "invoices" && (
                report.invoices.length === 0 ? (
                  <EmptyState title="لا توجد فواتير مطابقة للفلاتر المحددة." />
                ) : (
                  <>
                    <InvoiceProfitTable
                      rows={report.invoices}
                      locale={locale}
                      onOpen={(r) => void openDetail(r)}
                      onPdf={(r) => void saveInvoicePdf(r)}
                      pdfBusyId={pdfBusyId}
                    />
                    {totalPages > 1 && (
                      <div className="mt-3 flex items-center justify-between text-sm">
                        <span className="text-textSecondary">
                          صفحة {page} من {totalPages} — {report.totalInvoices} فاتورة
                        </span>
                        <div className="flex gap-2">
                          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                            السابق
                          </Button>
                          <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => goToPage(page + 1)}>
                            التالي
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )
              )}

              {tab !== "invoices" && aggregates && (() => {
                const map = {
                  products: { rows: aggregates.product, key: "كود الصنف", label: "الصنف" },
                  customers: { rows: aggregates.customer, key: "كود العميل", label: "العميل" },
                  branches: { rows: aggregates.branch, key: "المعرّف", label: "الفرع" },
                  representatives: { rows: aggregates.representative, key: "المعرّف", label: "مندوب المبيعات" },
                }[tab];
                return map.rows.length === 0 ? (
                  <EmptyState title="لا توجد بيانات مطابقة للفلاتر المحددة." />
                ) : (
                  <AggregateTable rows={map.rows} locale={locale} keyHeader={map.key} labelHeader={map.label} />
                );
              })()}
            </CardBody>
          </Card>

          {/* ── نظرة سريعة ─────────────────────────────────────────────────── */}
          {report.invoices.length > 0 && (
            <div className="grid gap-3 lg:grid-cols-3">
              {[
                { title: "أعلى الفواتير ربحًا", rows: insights.topInvoices.map((r) => ({ k: `#${r.invoiceNumber}`, v: r.finalProfit })) },
                { title: "أقل الفواتير ربحًا", rows: insights.bottomInvoices.map((r) => ({ k: `#${r.invoiceNumber}`, v: r.finalProfit })) },
                { title: "أعلى الأصناف ربحًا", rows: insights.topProducts.map((g) => ({ k: g.label, v: g.finalProfit })) },
                { title: "أقل الأصناف هامشًا", rows: insights.worstMarginProducts.map((g) => ({ k: g.label, v: g.finalMarginPct, pct: true })) },
                { title: "العملاء الأعلى ربحية", rows: insights.topCustomers.map((g) => ({ k: g.label, v: g.finalProfit })) },
                { title: "الفروع الأعلى ربحية", rows: (aggregates?.branch ?? []).map((g) => ({ k: g.label, v: g.finalProfit })) },
              ].map((box) => (
                <Card key={box.title}>
                  <CardBody>
                    <h3 className="mb-2 text-sm font-semibold">{box.title}</h3>
                    {box.rows.length === 0 ? (
                      <p className="text-xs text-textSecondary">لا توجد بيانات كافية.</p>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {box.rows.map((r, i) => (
                          <li key={`${r.k}-${i}`} className="flex justify-between gap-2">
                            <span className="truncate">{r.k}</span>
                            <span dir="ltr">
                              {"pct" in r && r.pct ? <Pct value={r.v as string | null} /> : <Money value={r.v as string | null} locale={locale} />}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <InvoiceProfitDetail
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        locale={locale}
        pdfBusy={pdfBusyId !== null}
        onPdf={() => detail && void saveInvoicePdf(detail.invoice)}
      />
    </div>
  );
}
