"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { EmptyState } from "../../../../../components/ui/empty-state";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { LegacyReturnFormModal } from "../../../../../components/features/legacy-returns/legacy-return-form-modal";
import { ApiClientError, apiCall } from "../../../../../lib/api-client";
import { useHasRole } from "../../../../../lib/auth";
import { formatCurrency, formatDate } from "../../../../../lib/format";
import { listCustomers, type CustomerRow } from "../../../../../lib/customers-client";
import {
  downloadLegacyReturnsListPdf,
  listLegacyReturns,
  type LegacyReturnFilters,
  type LegacyReturnRow,
} from "../../../../../lib/legacy-returns-client";

interface BranchOption {
  id: string;
  nameAr: string;
  active: boolean;
}

const STATUS_AR: Record<string, string> = { DRAFT: "مسودة", CONFIRMED: "مؤكد", CANCELLED: "ملغي" };
const PAGE_SIZE = 50;

/**
 * مردودات بدون فواتير.
 *
 * Goods sold before this ERP existed, coming back with only a paper invoice to
 * identify them. The document records that paper as a reference — there is no
 * electronic invoice behind it and the screen never pretends otherwise.
 */
export default function LegacyReturnsPage() {
  const locale = useLocale() as AppLocale;
  const canCreate = useHasRole("ACCOUNTANT");

  const [rows, setRows] = useState<LegacyReturnRow[]>([]);
  const [meta, setMeta] = useState<{ totalCount: number; totalAmount: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);

  const [filters, setFilters] = useState<LegacyReturnFilters>({});
  const [page, setPage] = useState(0);

  useEffect(() => {
    void listCustomers().then(setCustomers).catch(() => setCustomers([]));
    void apiCall<BranchOption[]>("/branches")
      .then((b) => setBranches(b.filter((x) => x.active)))
      .catch(() => setBranches([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listLegacyReturns({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      setRows(res.rows);
      setMeta({ totalCount: res.totalCount, totalAmount: res.totalAmount });
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر تحميل المردودات.");
    } finally {
      setLoading(false);
    }
  }, [filters, page, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  // A new filter starts a new result set, not page 4 of the previous one.
  useEffect(() => setPage(0), [filters]);

  const savePdf = async () => {
    setPdfBusy(true);
    setError(null);
    try {
      await downloadLegacyReturnsListPdf(filters, locale);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر إنشاء ملف PDF.");
    } finally {
      setPdfBusy(false);
    }
  };

  const set = (patch: Partial<LegacyReturnFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">مردودات بدون فواتير</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => void savePdf()} disabled={pdfBusy} data-testid="lr-save-pdf">
            {pdfBusy ? "جارٍ إنشاء الملف…" : "حفظ PDF"}
          </Button>
          {canCreate && (
            <Button variant="success" data-testid="lr-add" onClick={() => setFormOpen(true)}>
              + إضافة مرتجع بدون فاتورة
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="lr-q">بحث</Label>
            <Input
              id="lr-q"
              data-testid="lr-q"
              placeholder="رقم المرتجع أو اسم العميل"
              value={filters.q ?? ""}
              onChange={(e) => set({ q: e.target.value })}
              className="w-56"
            />
          </div>
          <div>
            <Label htmlFor="lr-paper">رقم الفاتورة الورقية</Label>
            <Input
              id="lr-paper"
              data-testid="lr-paper"
              value={filters.paperInvoiceNumber ?? ""}
              onChange={(e) => set({ paperInvoiceNumber: e.target.value })}
              className="w-44"
            />
          </div>
          <div>
            <Label htmlFor="lr-customer">العميل</Label>
            <select
              id="lr-customer"
              data-testid="lr-customer"
              value={filters.customerId ?? ""}
              onChange={(e) => set({ customerId: e.target.value })}
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="">كل العملاء</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nameAr}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="lr-branch">المخزن</Label>
            <select
              id="lr-branch"
              data-testid="lr-branch"
              value={filters.branchId ?? ""}
              onChange={(e) => set({ branchId: e.target.value })}
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="">كل المخازن</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.nameAr}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="lr-status">الحالة</Label>
            <select
              id="lr-status"
              data-testid="lr-status"
              value={filters.status ?? ""}
              onChange={(e) => set({ status: e.target.value as LegacyReturnFilters["status"] })}
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="">كل الحالات</option>
              <option value="DRAFT">مسودة</option>
              <option value="CONFIRMED">مؤكد</option>
              <option value="CANCELLED">ملغي</option>
            </select>
          </div>
          <div>
            <Label htmlFor="lr-from">من تاريخ</Label>
            <Input id="lr-from" type="date" value={filters.from ?? ""} onChange={(e) => set({ from: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="lr-to">إلى تاريخ</Label>
            <Input id="lr-to" type="date" value={filters.to ?? ""} onChange={(e) => set({ to: e.target.value })} />
          </div>
          <Button variant="ghost" onClick={() => setFilters({})}>
            مسح الفلاتر
          </Button>
        </CardBody>
      </Card>

      {error && <Alert variant="error">{error}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>المردودات</CardTitle>
        </CardHeader>
        <CardBody>
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : rows.length === 0 ? (
            <EmptyState title="لا توجد مردودات بدون فواتير مطابقة." />
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>رقم المرتجع</TH>
                    <TH>تاريخ المرتجع</TH>
                    <TH>العميل</TH>
                    <TH>رقم الفاتورة الورقية</TH>
                    <TH>تاريخ الفاتورة الأصلية</TH>
                    <TH>المخزن</TH>
                    <TH>عدد الأصناف</TH>
                    <TH>إجمالي القيمة</TH>
                    <TH>الحالة</TH>
                    <TH>أنشأ بواسطة</TH>
                    <TH>الإجراءات</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((r) => (
                    <TR key={r.id} data-testid={`lr-row-${r.returnNumber}`}>
                      <TD className="font-mono">LRN-{r.returnNumber}</TD>
                      <TD>{formatDate(r.returnDate, locale)}</TD>
                      <TD>{r.customerNameAr}</TD>
                      <TD>{r.paperInvoiceNumber}</TD>
                      <TD>{formatDate(r.paperInvoiceDate, locale)}</TD>
                      <TD>{r.branchNameAr}</TD>
                      <TD dir="ltr">{r.lineCount}</TD>
                      <TD dir="ltr">{formatCurrency(r.grandTotal, locale)}</TD>
                      <TD>
                        <Badge
                          variant={
                            r.status === "CONFIRMED" ? "success" : r.status === "CANCELLED" ? "neutral" : "warning"
                          }
                        >
                          {STATUS_AR[r.status]}
                        </Badge>
                      </TD>
                      <TD className="text-textSecondary">{r.createdByName}</TD>
                      <TD>
                        <Link href={`/${locale}/sales/legacy-returns/${r.id}`}>
                          <Button variant="ghost" size="sm">
                            تفاصيل
                          </Button>
                        </Link>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>

              {meta && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span className="text-textSecondary">
                    {meta.totalCount} مستند — إجمالي القيمة:{" "}
                    <b dir="ltr">{formatCurrency(meta.totalAmount, locale)}</b>
                  </span>
                  {meta.totalCount > PAGE_SIZE && (
                    <span className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                        السابق
                      </Button>
                      <span className="text-textSecondary">
                        صفحة {page + 1} من {Math.ceil(meta.totalCount / PAGE_SIZE)}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={(page + 1) * PAGE_SIZE >= meta.totalCount}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        التالي
                      </Button>
                    </span>
                  )}
                </div>
              )}
            </>
          )}
          <p className="mt-3 text-xs text-textSecondary">
            مردود بضاعة مباعة قبل تشغيل النظام. رقم الفاتورة الورقية مرجع فقط ولا يوجد له نظير إلكتروني، وقيمة
            المرتجع تُضاف إلى حساب العميل دون أي صرف نقدي.
          </p>
        </CardBody>
      </Card>

      <LegacyReturnFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        customers={customers}
        branches={branches}
        onCustomersChanged={(next) => setCustomers(next)}
        onCreated={() => {
          setFormOpen(false);
          void load();
        }}
      />
    </div>
  );
}
