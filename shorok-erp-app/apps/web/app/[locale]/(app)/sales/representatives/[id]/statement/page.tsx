"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../../../../../i18n";
import { Alert } from "../../../../../../../components/ui/alert";
import { Button } from "../../../../../../../components/ui/button";
import { Card, CardBody } from "../../../../../../../components/ui/card";
import { Skeleton } from "../../../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../../components/ui/table";
import { ApiClientError } from "../../../../../../../lib/api-client";
import { listBranches } from "../../../../../../../lib/inventory-client";
import { sourceDocumentHref } from "../../../../../../../lib/source-document";
import {
  getRepresentativeStatement,
  type RepStatement,
  type RepStatementRow,
} from "../../../../../../../lib/sales-representatives-client";

function fmt(v: string | number) {
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function BalanceText({ v, zeroLabel }: { v: string; zeroLabel: string }) {
  const n = parseFloat(v);
  if (n === 0) return <span className="text-textSecondary">{fmt(0)}</span>;
  if (n < 0) return <span className="text-green-600">{fmt(Math.abs(n))} ({zeroLabel})</span>;
  return <span className="text-red-600">{fmt(n)}</span>;
}

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card>
      <CardBody className="text-center">
        <div className="text-xs text-textSecondary mb-1">{label}</div>
        <div className="font-bold text-base">{value}</div>
      </CardBody>
    </Card>
  );
}

export default function RepresentativeStatementPage() {
  const t = useTranslations("salesReps");
  const locale = useLocale() as AppLocale;
  const params = useParams();
  const id = params.id as string;

  const [branches, setBranches] = useState<{ id: string; nameAr: string }[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [branchId, setBranchId] = useState("");
  const [type, setType] = useState<"all" | "invoice" | "journal">("all");
  const [invoiceStatus, setInvoiceStatus] = useState<"" | "DRAFT" | "CONFIRMED" | "PAID" | "CANCELLED">("");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<RepStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (toPage?: number) => {
    const wanted = toPage ?? 1;
    setLoading(true);
    setError(null);
    try {
      const res = await getRepresentativeStatement(id, {
        from: from || undefined,
        to: to || undefined,
        branchId: branchId || undefined,
        type,
        invoiceStatus: invoiceStatus || undefined,
        page: wanted,
      });
      setData(res);
      setPage(res.page);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [id, from, to, branchId, type, invoiceStatus, locale, t]);

  useEffect(() => {
    void (async () => {
      try {
        const b = await listBranches();
        setBranches(b.map((x) => ({ id: x.id, nameAr: x.nameAr })));
      } catch { /* branch filter is optional */ }
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function rowHref(r: RepStatementRow): string | null {
    return sourceDocumentHref({ sourceType: r.sourceType, sourceId: r.sourceId, journalEntryId: r.journalEntryId }, locale);
  }

  return (
    <div className="space-y-6" dir={locale === "ar" ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">{t("statement")}</h1>
        {data && (
          <Link href={`/${locale}/sales/representatives/${id}`} className="text-sm text-blue-600 hover:underline">
            {data.representative.code} — {data.representative.nameAr}
          </Link>
        )}
      </div>

      {/* Filters */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
          <div>
            <label className="block text-xs text-textSecondary mb-1">{t("from")}</label>
            <input type="date" className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-textSecondary mb-1">{t("to")}</label>
            <input type="date" className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-textSecondary mb-1">{t("branch")}</label>
            <select className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">{t("allBranches")}</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.nameAr}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-textSecondary mb-1">{t("type")}</label>
            <select className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="all">{t("typeAll")}</option>
              <option value="invoice">{t("typeInvoice")}</option>
              <option value="journal">{t("typeJournal")}</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-textSecondary mb-1">{t("invoiceStatus")}</label>
            <select className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background" value={invoiceStatus} onChange={(e) => setInvoiceStatus(e.target.value as typeof invoiceStatus)}>
              <option value="">{t("statusAll")}</option>
              <option value="DRAFT">{t("statusDraft")}</option>
              <option value="CONFIRMED">{t("statusConfirmed")}</option>
              <option value="PAID">{t("statusPaid")}</option>
              <option value="CANCELLED">{t("statusCancelled")}</option>
            </select>
          </div>
          <div className="flex items-end">
            <Button onClick={() => void load(1)} disabled={loading} className="w-full">{loading ? t("loading") : t("apply")}</Button>
          </div>
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {loading && <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>}

      {data && !loading && (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <StatCard label={t("openingBalance")} value={<BalanceText v={data.openingBalance} zeroLabel={t("balanceCredit")} />} />
            <StatCard label={t("periodDebit")} value={<span className="text-red-600">{fmt(data.periodDebit)}</span>} />
            <StatCard label={t("periodCredit")} value={<span className="text-green-600">{fmt(data.periodCredit)}</span>} />
            <StatCard label={t("closingBalance")} value={<BalanceText v={data.closingBalance} zeroLabel={t("balanceCredit")} />} />
            <StatCard label={t("salesInvoiceCount")} value={String(data.salesInvoiceCount)} />
            <StatCard label={t("confirmedSalesTotal")} value={fmt(data.confirmedSalesTotal)} />
          </div>

          {/* Combined timeline */}
          <Table>
            <THead>
              <TR>
                <TH>{t("date")}</TH>
                <TH>{t("type")}</TH>
                <TH>{t("reference")}</TH>
                <TH>{t("counterparty")}</TH>
                <TH>{t("branch")}</TH>
                <TH className="text-center">{t("invoiceValue")}</TH>
                <TH className="text-center">{t("debit")}</TH>
                <TH className="text-center">{t("credit")}</TH>
                <TH className="text-center">{t("runningBalance")}</TH>
                <TH>{t("status")}</TH>
                <TH>{t("open")}</TH>
              </TR>
            </THead>
            <TBody>
              {data.rows.length === 0 ? (
                <TR><TD colSpan={11} className="text-center text-textSecondary py-6">{t("noRows")}</TD></TR>
              ) : (
                data.rows.map((r, idx) => {
                  const href = rowHref(r);
                  const isInvoice = r.kind === "SALES_INVOICE";
                  return (
                    <TR key={`${r.kind}-${r.journalLineId ?? r.salesInvoiceId ?? idx}`}>
                      <TD>{new Date(r.date).toLocaleDateString("ar-EG")}</TD>
                      <TD>{isInvoice ? t("salesInvoice") : t("journalEntry")}</TD>
                      <TD className="font-mono text-xs">{r.reference ?? "—"}</TD>
                      <TD>{r.counterparty ?? "—"}</TD>
                      <TD>{r.branchName ?? "—"}</TD>
                      <TD className="text-center">{r.invoiceValue ? fmt(r.invoiceValue) : "—"}</TD>
                      <TD className="text-center text-red-600">{r.debit && parseFloat(r.debit) > 0 ? fmt(r.debit) : "—"}</TD>
                      <TD className="text-center text-green-600">{r.credit && parseFloat(r.credit) > 0 ? fmt(r.credit) : "—"}</TD>
                      <TD className="text-center"><BalanceText v={r.runningBalance} zeroLabel={t("balanceCredit")} /></TD>
                      <TD className="text-xs">{r.status ?? "—"}</TD>
                      <TD>{href ? <Link href={href} className="text-blue-600 hover:underline">{t("open")}</Link> : "—"}</TD>
                    </TR>
                  );
                })
              )}
            </TBody>
          </Table>

          {/* Pagination over the combined timeline */}
          <div className="flex items-center justify-between gap-3 flex-wrap text-sm">
            <div className="text-textSecondary">
              {t("rowsTotal")}: {data.totalRows}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" disabled={!data.hasPrev || loading} onClick={() => void load(data.page - 1)}>
                {t("previous")}
              </Button>
              <span className="text-textSecondary">{t("page")} {data.page} {t("of")} {data.totalPages}</span>
              <Button variant="ghost" disabled={!data.hasNext || loading} onClick={() => void load(data.page + 1)}>
                {t("next")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
