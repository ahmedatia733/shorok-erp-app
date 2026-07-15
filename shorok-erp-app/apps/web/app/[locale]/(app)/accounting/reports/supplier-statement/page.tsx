"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Input } from "../../../../../../components/ui/input";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { SupplierPicker } from "../../../../../../components/features/factory-ledger/supplier-picker";
import { getSupplierStatement, type SupplierStatementData } from "../../../../../../lib/reports-client";
import { formatDate, formatCurrency } from "../../../../../../lib/format";
import { statementRowLabel } from "../../../../../../lib/statement-labels";
import { sourceDocumentHref } from "../../../../../../lib/source-document";
import { ApiClientError } from "../../../../../../lib/api-client";

export default function SupplierStatementPage() {
  const locale = useLocale() as AppLocale;

  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<SupplierStatementData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!supplierId) return;
    setLoading(true);
    setError(null);
    try {
      setData(await getSupplierStatement(supplierId, from || undefined, to || undefined));
    } catch (e) {
      setData(null);
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر تحميل كشف الحساب. حاول مرة أخرى.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4 max-w-5xl" dir="rtl">
      <h1 className="text-xl font-bold">كشف حساب المورد</h1>

      <Card>
        <CardBody>
          <div className="flex flex-wrap gap-3 items-end">
            <div className="min-w-[220px]">
              <label className="block text-sm font-medium mb-1">المورد *</label>
              <SupplierPicker value={supplierId} onChange={setSupplierId} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">من</label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">إلى</label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" />
            </div>
            <Button onClick={() => void load()} disabled={!supplierId || loading}>
              {loading ? "جاري التحميل..." : "عرض الكشف"}
            </Button>
          </div>
        </CardBody>
      </Card>

      {error && (
        <Alert variant="error">
          {error} <button type="button" className="underline font-medium ms-1" onClick={() => void load()}>إعادة المحاولة</button>
        </Alert>
      )}

      {loading && (
        <div className="space-y-2">
          <Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" />
        </div>
      )}

      {data && !loading && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <SummaryCard label="رصيد افتتاحي" value={formatCurrency(data.openingBalance, locale)} />
            <SummaryCard label="مدين (سداد)" value={formatCurrency(data.periodDebit, locale)} />
            <SummaryCard label="دائن (مشتريات)" value={formatCurrency(data.periodCredit, locale)} />
            <SummaryCard label="الرصيد المستحق" value={formatCurrency(data.endingBalance, locale)} strong={parseFloat(data.endingBalance) !== 0} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>
                كشف حساب — {data.supplier.nameAr}
                {(from || to) && <span className="font-normal text-sm text-textSecondary ms-2">{from && `من ${from}`} {to && `إلى ${to}`}</span>}
              </CardTitle>
            </CardHeader>
            <CardBody className="p-0 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>التاريخ</TH>
                    <TH>المرجع</TH>
                    <TH>البيان / المستند</TH>
                    <TH>مدين</TH>
                    <TH>دائن</TH>
                    <TH>الرصيد</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.rows.length === 0 ? (
                    <TR><TD colSpan={6} className="text-center text-textSecondary py-8">لا توجد حركات لهذا المورد في هذه الفترة</TD></TR>
                  ) : (
                    data.rows.map((row) => {
                      const href = sourceDocumentHref({ sourceType: row.sourceType, sourceId: row.sourceId, journalEntryId: row.journalEntryId }, locale);
                      const label = statementRowLabel(row);
                      return (
                        <TR key={row.journalLineId}>
                          <TD>{formatDate(row.entryDate, locale)}</TD>
                          <TD className="font-mono text-xs">
                            {href ? <Link href={href} className="text-blue-600 hover:underline">{row.reference ?? "قيد"}</Link> : (row.reference ?? "—")}
                          </TD>
                          <TD>{href ? <Link href={href} className="text-blue-600 hover:underline">{label}</Link> : label}</TD>
                          <TD dir="ltr" className={parseFloat(row.debit) > 0 ? "text-green-700 font-medium" : "text-textSecondary"}>{parseFloat(row.debit) > 0 ? formatCurrency(row.debit, locale) : "—"}</TD>
                          <TD dir="ltr" className={parseFloat(row.credit) > 0 ? "text-red-600 font-medium" : "text-textSecondary"}>{parseFloat(row.credit) > 0 ? formatCurrency(row.credit, locale) : "—"}</TD>
                          <TD dir="ltr" className="font-semibold">{formatCurrency(row.runningBalance, locale)}</TD>
                        </TR>
                      );
                    })
                  )}
                  <TR>
                    <TD colSpan={5} className="text-end font-bold">الرصيد المستحق</TD>
                    <TD dir="ltr" className="font-bold">{formatCurrency(data.endingBalance, locale)}</TD>
                  </TR>
                </TBody>
              </Table>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Card>
      <CardBody>
        <div className="text-sm text-textSecondary">{label}</div>
        <div className={"mt-1 text-lg font-bold " + (strong ? "text-red-600" : "")} dir="ltr">{value}</div>
      </CardBody>
    </Card>
  );
}
