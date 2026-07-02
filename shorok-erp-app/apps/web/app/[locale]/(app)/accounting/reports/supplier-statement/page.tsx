"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
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

export default function SupplierStatementPage() {
  const locale = useLocale() as AppLocale;

  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [from,       setFrom]       = useState("");
  const [to,         setTo]         = useState("");
  const [data,       setData]       = useState<SupplierStatementData | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  async function load() {
    if (!supplierId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getSupplierStatement(supplierId, from || undefined, to || undefined);
      setData(result);
    } catch {
      setError("فشل تحميل كشف الحساب");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4 max-w-5xl" dir="rtl">
      <h1 className="text-xl font-bold">كشف حساب المورد</h1>

      {error && <Alert variant="error">{error}</Alert>}

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

      {loading && (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      )}

      {data && !loading && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Card>
              <CardBody>
                <div className="text-sm text-textSecondary">إجمالي المشتريات</div>
                <div className="mt-1 text-lg font-bold" dir="ltr">
                  {formatCurrency(data.totalPurchases, locale)}
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <div className="text-sm text-textSecondary">إجمالي المدفوع</div>
                <div className="mt-1 text-lg font-bold" dir="ltr">
                  {formatCurrency(data.totalPaid, locale)}
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <div className="text-sm text-textSecondary">الرصيد الختامي</div>
                <div className={"mt-1 text-lg font-bold " + (parseFloat(data.closingBalance) > 0 ? "text-red-600" : "text-green-700")} dir="ltr">
                  {formatCurrency(data.closingBalance, locale)}
                </div>
              </CardBody>
            </Card>
          </div>

          {/* Statement table */}
          <Card>
            <CardHeader>
              <CardTitle>
                كشف حساب — {data.supplier.nameAr}
                {(from || to) && (
                  <span className="font-normal text-sm text-textSecondary ms-2">
                    {from && `من ${from}`} {to && `إلى ${to}`}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardBody className="p-0 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>التاريخ</TH>
                    <TH>النوع</TH>
                    <TH>البيان</TH>
                    <TH>مشتريات</TH>
                    <TH>مدفوعات</TH>
                    <TH>الرصيد</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.rows.length === 0 ? (
                    <TR>
                      <TD colSpan={6} className="text-center text-gray-400 py-8">لا توجد حركات</TD>
                    </TR>
                  ) : (
                    data.rows.map((row) => {
                      const balance = parseFloat(row.runningBalance);
                      return (
                        <TR key={row.id}>
                          <TD>{formatDate(row.date, locale)}</TD>
                          <TD>
                            <span className={
                              "inline-flex rounded px-1.5 py-0.5 text-xs font-medium " +
                              (row.type === "purchase" ? "bg-blue-100 text-blue-800" :
                               row.type === "payment"  ? "bg-green-100 text-green-800" :
                               "bg-gray-100 text-gray-700")
                            }>
                              {row.type === "purchase" ? "شراء" : row.type === "payment" ? "دفعة" : "أخرى"}
                            </span>
                          </TD>
                          <TD>{row.description}</TD>
                          <TD dir="ltr">{row.type === "purchase" ? formatCurrency(row.totalAmount, locale) : "—"}</TD>
                          <TD dir="ltr">{row.type === "payment" ? formatCurrency(row.paidAmount, locale) : "—"}</TD>
                          <TD dir="ltr" className={"font-semibold " + (balance > 0 ? "text-red-600" : "text-green-700")}>
                            {formatCurrency(row.runningBalance, locale)}
                          </TD>
                        </TR>
                      );
                    })
                  )}
                  {/* Closing balance row */}
                  <TR>
                    <TD colSpan={5} className="text-end font-bold">الرصيد الختامي</TD>
                    <TD dir="ltr" className={"font-bold " + (parseFloat(data.closingBalance) > 0 ? "text-red-600" : "text-green-700")}>
                      {formatCurrency(data.closingBalance, locale)}
                    </TD>
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
