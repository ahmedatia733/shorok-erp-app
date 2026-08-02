"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../i18n";
import { Alert } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { Skeleton } from "../ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../ui/table";
import { SearchableSelect, type SearchableOption } from "../ui/searchable-select";
import { ApiClientError } from "../../lib/api-client";
import { formatCurrency, formatDate, formatDateTime, formatNumber } from "../../lib/format";
import { listCustomers } from "../../lib/customers-client";
import { listVariants } from "../../lib/inventory-client";
import { variantLabel, variantSearchText } from "../../lib/variant-select";
import {
  getHistoricalSalesReturn,
  listHistoricalSalesReturns,
  type HistoricalSalesReturnDetail,
  type HistoricalSalesReturnSummary,
  type HistoricalSalesReturnTotals,
} from "../../lib/historical-returns-client";

const ALL = "all";

/**
 * Historical sales-return archive (أرشيف مردودات المبيعات) — READ ONLY.
 *
 * These rows are the six July 2026 paper returns. They are already inside the
 * approved opening AR balances and the opening physical count, so they never
 * posted and never will. That is why this section renders NO create, edit,
 * confirm, cancel or delete control at all — the absence is the contract, not
 * an oversight, and a disabled button would still imply the action exists.
 */
export function HistoricalReturnsSection() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("salesReturns.historical");

  const [rows, setRows] = useState<HistoricalSalesReturnSummary[]>([]);
  const [totals, setTotals] = useState<HistoricalSalesReturnTotals | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [customerId, setCustomerId] = useState(ALL);
  const [productVariantId, setProductVariantId] = useState(ALL);

  const [customerOptions, setCustomerOptions] = useState<SearchableOption[]>([]);
  const [variantOptions, setVariantOptions] = useState<SearchableOption[]>([]);

  const [openId, setOpenId] = useState<string | null>(null);

  const filters = useMemo(
    () => ({
      q: q.trim() || undefined,
      from: from || undefined,
      to: to || undefined,
      customerId: customerId === ALL ? undefined : customerId,
      productVariantId: productVariantId === ALL ? undefined : productVariantId,
    }),
    [q, from, to, customerId, productVariantId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listHistoricalSalesReturns(filters);
      setRows(res.items);
      setTotals(res.totals);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setRows([]);
      setTotals(null);
      setNextCursor(null);
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [filters, locale, t]);

  useEffect(() => { void load(); }, [load]);

  // The customer/product filters need master data the archive only references by
  // id; a failure there must not hide the archive itself, so it degrades to an
  // "all" list rather than an error.
  useEffect(() => {
    let alive = true;
    void listCustomers()
      .then((cs) => {
        if (!alive) return;
        setCustomerOptions(cs.map((c) => ({ value: c.id, label: `${c.code} — ${c.nameAr}`, keywords: `${c.code} ${c.nameAr} ${c.phone ?? ""}` })));
      })
      .catch(() => undefined);
    void listVariants()
      .then((vs) => {
        if (!alive) return;
        setVariantOptions(vs.map((v) => {
          const item = { id: v.id, skuCode: v.sku.code, colorNameAr: v.sku.colorNameAr, colorNameEn: v.sku.colorNameEn, sizeMetersPerBoard: v.sizeMetersPerBoard };
          return { value: v.id, label: variantLabel(item), keywords: variantSearchText(item) };
        }));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await listHistoricalSalesReturns({ ...filters, cursor: nextCursor });
      setRows((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("loadError"));
    } finally {
      setLoadingMore(false);
    }
  };

  const clearFilters = () => {
    setQ("");
    setFrom("");
    setTo("");
    setCustomerId(ALL);
    setProductVariantId(ALL);
  };

  const customerPicker: SearchableOption[] = [{ value: ALL, label: t("allCustomers"), pinned: true }, ...customerOptions];
  const productPicker: SearchableOption[] = [{ value: ALL, label: t("allProducts"), pinned: true }, ...variantOptions];

  return (
    <div className="space-y-4" data-testid="historical-returns-section">
      {/* The archive's whole reason for existing — stated before any row is read. */}
      <div data-testid="historical-returns-explanation">
        <Alert variant="info" className="whitespace-pre-line">{t("explanation")}</Alert>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <p className="text-xs text-textSecondary">{t("subtitle")}</p>
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="flex flex-col lg:col-span-2">
              <label htmlFor="hist-q" className="mb-1 text-xs font-medium text-textSecondary">{t("search")}</label>
              <Input id="hist-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchPlaceholder")} data-testid="historical-search" />
            </div>
            <div className="flex flex-col">
              <label htmlFor="hist-from" className="mb-1 text-xs font-medium text-textSecondary">{t("fromDate")}</label>
              <Input id="hist-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="historical-from" />
            </div>
            <div className="flex flex-col">
              <label htmlFor="hist-to" className="mb-1 text-xs font-medium text-textSecondary">{t("toDate")}</label>
              <Input id="hist-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="historical-to" />
            </div>
            <div className="flex flex-col">
              <label htmlFor="hist-customer" className="mb-1 text-xs font-medium text-textSecondary">{t("customer")}</label>
              <SearchableSelect id="hist-customer" testId="historical-customer" value={customerId} onChange={setCustomerId} options={customerPicker} placeholder={t("allCustomers")} />
            </div>
            <div className="flex flex-col sm:col-span-2 lg:col-span-2">
              <label htmlFor="hist-product" className="mb-1 text-xs font-medium text-textSecondary">{t("product")}</label>
              <SearchableSelect id="hist-product" testId="historical-product" value={productVariantId} onChange={setProductVariantId} options={productPicker} placeholder={t("allProducts")} />
            </div>
            <div className="flex items-end">
              <Button variant="ghost" size="sm" onClick={clearFilters}>{t("clearFilters")}</Button>
            </div>
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          {/* Totals span the whole filtered archive, not the loaded page. */}
          {totals && (
            <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4" data-testid="historical-totals">
              <TotalCell label={t("totalCount")} value={formatNumber(totals.count, locale)} />
              <TotalCell label={t("totalValue")} value={formatCurrency(totals.grossValue, locale)} />
              <TotalCell label={t("totalBoards")} value={formatNumber(totals.boards, locale)} />
              <TotalCell label={t("totalMeters")} value={formatNumber(totals.canonicalMeters, locale)} />
            </div>
          )}

          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{t("colArchiveNumber")}</TH><TH>{t("colDate")}</TH><TH>{t("colReference")}</TH><TH>{t("colCustomer")}</TH>
                  <TH>{t("colOriginalInvoice")}</TH><TH>{t("colValue")}</TH><TH>{t("colBoards")}</TH><TH>{t("colMeters")}</TH>
                  <TH>{t("colNote")}</TH><TH>{t("colDetails")}</TH>
                </TR>
              </THead>
              <TBody>
                {rows.length === 0 && <TR><TD colSpan={10}><span className="text-sm text-textSecondary">{t("empty")}</span></TD></TR>}
                {rows.map((r) => (
                  <TR key={r.id} data-testid="historical-return-row">
                    <TD className="tabular-nums" dir="ltr">{formatNumber(r.archiveNumber, locale)}</TD>
                    <TD>{formatDate(r.documentDate, locale)}</TD>
                    <TD className="font-mono text-xs">{r.sourceReference}</TD>
                    <TD><CustomerCell row={r} asWritten={t("asWritten")} /></TD>
                    <TD className="font-mono text-xs">{r.originalInvoiceReference ?? "—"}</TD>
                    <TD className="tabular-nums" dir="ltr">{formatCurrency(r.grossValue, locale)}</TD>
                    <TD className="tabular-nums" dir="ltr">{formatNumber(r.totalBoards, locale)}</TD>
                    <TD className="tabular-nums" dir="ltr">{formatNumber(r.totalCanonicalMeters, locale)}</TD>
                    <TD><HistoricalBadge label={t("badge")} /></TD>
                    <TD>
                      <button type="button" className="text-sm text-primary underline" onClick={() => setOpenId(r.id)} data-testid="historical-return-view">
                        {t("view")}
                      </button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}

          {nextCursor && (
            <div className="flex justify-center">
              <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>{t("loadMore")}</Button>
            </div>
          )}
        </CardBody>
      </Card>

      {openId && <HistoricalReturnDetailModal id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function TotalCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="mb-1 text-xs text-textSecondary">{label}</div>
      <div className="text-base font-semibold tabular-nums" dir="ltr">{value}</div>
    </div>
  );
}

/** The badge every archived row carries, on the list and in the detail view. */
function HistoricalBadge({ label }: { label: string }) {
  return <Badge variant="info" className="whitespace-nowrap" data-testid="historical-return-badge">{label}</Badge>;
}

/**
 * The resolved customer when the paper name matched a master row; otherwise the
 * name exactly as written, flagged as such so nobody reads it as a real link.
 */
function CustomerCell({ row, asWritten }: { row: HistoricalSalesReturnSummary; asWritten: string }) {
  if (row.customer) return <>{row.customer.nameAr}</>;
  return (
    <span title={asWritten}>
      {row.customerSourceReference}
      <span className="block text-xs text-textSecondary">{asWritten}</span>
    </span>
  );
}

function HistoricalReturnDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("salesReturns.historical");
  const [detail, setDetail] = useState<HistoricalSalesReturnDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getHistoricalSalesReturn(id)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("detailError"));
      });
    return () => { alive = false; };
  }, [id, locale, t]);

  return (
    <Modal open onClose={onClose} title={t("detailTitle")} className="w-full max-w-5xl">
      <div className="space-y-4" data-testid="historical-return-detail">
        <div className="flex flex-wrap items-center gap-2">
          <HistoricalBadge label={t("badge")} />
        </div>
        <Alert variant="info" className="whitespace-pre-line">{t("explanation")}</Alert>

        {error && <Alert variant="error">{error}</Alert>}
        {!detail && !error && <Skeleton className="h-40 w-full" />}

        {detail && (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <Field label={t("colArchiveNumber")} value={formatNumber(detail.archiveNumber, locale)} numeric />
              <Field label={t("colDate")} value={formatDate(detail.documentDate, locale)} />
              <Field label={t("colReference")} value={detail.sourceReference} mono />
              <Field label={t("colOriginalInvoice")} value={detail.originalInvoiceReference ?? "—"} mono />
              <Field label={t("colCustomer")} value={detail.customer?.nameAr ?? detail.customerSourceReference} hint={detail.customer ? undefined : t("asWritten")} />
              <Field label={t("colValue")} value={formatCurrency(detail.grossValue, locale)} numeric />
              <Field label={t("colBoards")} value={formatNumber(detail.totalBoards, locale)} numeric />
              <Field label={t("colMeters")} value={formatNumber(detail.totalCanonicalMeters, locale)} numeric />
              <Field label={t("lineCount")} value={formatNumber(detail.lineCount, locale)} numeric />
              <Field label={t("importedAt")} value={formatDateTime(detail.importedAt, locale)} />
              {detail.notes && <div className="col-span-2 md:col-span-4"><div className="text-xs text-textSecondary">{t("notes")}</div><div>{detail.notes}</div></div>}
            </div>

            <div>
              <h4 className="mb-2 text-sm font-semibold">{t("linesTitle")}</h4>
              <Table>
                <THead>
                  <TR>
                    <TH>{t("colLineNumber")}</TH><TH>{t("colProduct")}</TH><TH>{t("colSourceCode")}</TH>
                    <TH>{t("colBoards")}</TH><TH>{t("colMeters")}</TH><TH>{t("colUnitPrice")}</TH><TH>{t("colLineValue")}</TH>
                  </TR>
                </THead>
                <TBody>
                  {detail.lines.map((l) => (
                    <TR key={l.id}>
                      <TD className="tabular-nums" dir="ltr">{formatNumber(l.lineNumber, locale)}</TD>
                      <TD>
                        {l.productVariant
                          ? variantLabel({ id: l.productVariant.id, skuCode: l.productVariant.code, colorNameAr: l.productVariant.colorNameAr, sizeMetersPerBoard: l.productVariant.sizeMetersPerBoard })
                          : <span className="text-xs text-textSecondary">{t("unresolvedProduct")}</span>}
                      </TD>
                      <TD className="font-mono text-xs">{l.productSourceCode}</TD>
                      <TD className="tabular-nums" dir="ltr">{formatNumber(l.boards, locale)}</TD>
                      <TD className="tabular-nums" dir="ltr">{formatNumber(l.canonicalMeters, locale)}</TD>
                      <TD className="tabular-nums" dir="ltr">{l.unitPrice === null ? "—" : formatCurrency(l.unitPrice, locale)}</TD>
                      <TD className="tabular-nums" dir="ltr">{formatCurrency(l.lineValue, locale)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>

            {/* Provenance — what makes the archive auditable back to the paper. */}
            <div>
              <h4 className="mb-2 text-sm font-semibold">{t("sourceTitle")}</h4>
              <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <Field label={t("sourceSystem")} value={detail.sourceSystem} />
                <Field label={t("sourceSheet")} value={detail.sourceSheet} />
                <Field label={t("sourceRow")} value={formatNumber(detail.sourceRow, locale)} numeric />
                <Field label={t("importBatch")} value={detail.importBatchId} mono />
                <div className="col-span-2 md:col-span-4">
                  <div className="text-xs text-textSecondary">{t("sourceFileHash")}</div>
                  <div className="break-all font-mono text-xs" dir="ltr">{detail.sourceFileHash}</div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Close is the ONLY action: the archive has no edit/confirm/cancel path. */}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>{t("close")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, value, hint, mono = false, numeric = false }: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
  numeric?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-textSecondary">{label}</div>
      <div className={mono ? "font-mono text-xs" : numeric ? "tabular-nums" : undefined} dir={mono || numeric ? "ltr" : undefined}>{value}</div>
      {hint && <div className="text-xs text-textSecondary">{hint}</div>}
    </div>
  );
}
