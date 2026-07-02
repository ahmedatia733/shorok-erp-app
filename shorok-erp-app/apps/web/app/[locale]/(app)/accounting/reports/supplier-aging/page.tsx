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
import { getSupplierAging, type SupplierAgingData } from "../../../../../../lib/reports-client";
import { formatCurrency } from "../../../../../../lib/format";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function SupplierAgingPage() {
  const locale = useLocale() as AppLocale;

  const [asOf,    setAsOf]    = useState(todayISO());
  const [data,    setData]    = useState<SupplierAgingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await getSupplierAging(asOf));
    } catch {
      setError("فشل تحميل تقرير أعمار الدائنين");
    } finally {
      setLoading(false);
    }
  }

  const buckets = ["0-30", "31-60", "61-90", "90+"] as const;

  return (
    <div className="space-y-4 max-w-5xl" dir="rtl">
      <h1 className="text-xl font-bold">تقرير أعمار الدائنين</h1>

      {error && <Alert variant="error">{error}</Alert>}

      <Card>
        <CardBody>
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-sm font-medium mb-1">بتاريخ</label>
              <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-36" />
            </div>
            <Button onClick={() => void load()} disabled={loading}>
              {loading ? "جاري التحميل..." : "عرض التقرير"}
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
        <Card>
          <CardHeader>
            <CardTitle>
              أعمار الدائنين بتاريخ {data.asOf}
              <span className="ms-3 font-normal text-textSecondary text-sm">
                الإجمالي: {formatCurrency(data.grandTotal, locale)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardBody className="p-0 overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>المورد</TH>
                  <TH>الرصيد الكلي</TH>
                  <TH>0–30 يوم</TH>
                  <TH>31–60 يوم</TH>
                  <TH>61–90 يوم</TH>
                  <TH>+90 يوم</TH>
                  <TH>التصنيف</TH>
                </TR>
              </THead>
              <TBody>
                {data.rows.length === 0 ? (
                  <TR>
                    <TD colSpan={7} className="text-center text-gray-400 py-8">لا توجد أرصدة مستحقة</TD>
                  </TR>
                ) : (
                  data.rows.map((row) => {
                    const bucketColor: Record<string, string> = {
                      "0-30":  "bg-green-100 text-green-800",
                      "31-60": "bg-yellow-100 text-yellow-800",
                      "61-90": "bg-orange-100 text-orange-800",
                      "90+":   "bg-red-100 text-red-800",
                    };
                    return (
                      <TR key={row.supplierId}>
                        <TD className="font-medium">{row.nameAr}</TD>
                        <TD dir="ltr" className="font-bold text-red-600">{formatCurrency(row.balance, locale)}</TD>
                        <TD dir="ltr">{formatCurrency(row.bucketAmounts["0-30"],  locale)}</TD>
                        <TD dir="ltr">{formatCurrency(row.bucketAmounts["31-60"], locale)}</TD>
                        <TD dir="ltr">{formatCurrency(row.bucketAmounts["61-90"], locale)}</TD>
                        <TD dir="ltr">{formatCurrency(row.bucketAmounts["90+"],   locale)}</TD>
                        <TD>
                          <span className={"inline-flex rounded px-2 py-0.5 text-xs font-medium " + (bucketColor[row.agingBucket] ?? "")}>
                            {row.agingBucket} يوم
                          </span>
                        </TD>
                      </TR>
                    );
                  })
                )}
                {/* Grand total row */}
                {data.rows.length > 0 && (
                  <TR>
                    <TD className="font-bold">الإجمالي</TD>
                    <TD dir="ltr" className="font-bold text-red-600">{formatCurrency(data.grandTotal, locale)}</TD>
                    {buckets.map((b) => {
                      const sum = data.rows.reduce((a, r) => a + parseFloat(r.bucketAmounts[b] ?? "0"), 0);
                      return <TD key={b} dir="ltr" className="font-semibold">{formatCurrency(sum.toFixed(2), locale)}</TD>;
                    })}
                    <TD />
                  </TR>
                )}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
