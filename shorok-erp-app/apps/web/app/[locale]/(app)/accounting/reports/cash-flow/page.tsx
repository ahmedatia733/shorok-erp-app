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
import { getCashFlow, type CashFlowData } from "../../../../../../lib/reports-client";
import { formatDate, formatCurrency } from "../../../../../../lib/format";

function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function CashFlowPage() {
  const locale = useLocale() as AppLocale;

  const [from,    setFrom]    = useState(monthStart());
  const [to,      setTo]      = useState(todayISO());
  const [data,    setData]    = useState<CashFlowData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [expandLines, setExpandLines] = useState(false);

  async function load() {
    if (!from || !to) return;
    setLoading(true);
    setError(null);
    try {
      setData(await getCashFlow(from, to));
    } catch {
      setError("فشل تحميل تقرير التدفق النقدي");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4 max-w-5xl" dir="rtl">
      <h1 className="text-xl font-bold">قائمة التدفقات النقدية</h1>

      {error && <Alert variant="error">{error}</Alert>}

      <Card>
        <CardBody>
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-sm font-medium mb-1">من *</label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" required />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">إلى *</label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" required />
            </div>
            <Button onClick={() => void load()} disabled={loading || !from || !to}>
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
        <>
          {/* Cash accounts identified */}
          {data.cashAccounts.length > 0 && (
            <div className="text-xs text-textSecondary bg-blue-50 rounded p-2">
              الحسابات النقدية المحددة:{" "}
              {data.cashAccounts.map((a) => `${a.code} — ${a.nameAr}`).join(" ، ")}
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* Operating */}
            <Card>
              <CardHeader><CardTitle>الأنشطة التشغيلية</CardTitle></CardHeader>
              <CardBody>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-textSecondary">تدفقات واردة</span>
                    <span className="text-green-700 font-medium" dir="ltr">{formatCurrency(data.operatingInflow, locale)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-textSecondary">تدفقات صادرة</span>
                    <span className="text-red-600 font-medium" dir="ltr">{formatCurrency(data.operatingOutflow, locale)}</span>
                  </div>
                  <div className={"flex justify-between font-bold border-t pt-1 " + (parseFloat(data.netOperating) >= 0 ? "text-green-700" : "text-red-600")}>
                    <span>صافي التشغيل</span>
                    <span dir="ltr">{formatCurrency(data.netOperating, locale)}</span>
                  </div>
                </div>
              </CardBody>
            </Card>

            {/* Investing */}
            <Card>
              <CardHeader><CardTitle>الأنشطة الاستثمارية</CardTitle></CardHeader>
              <CardBody>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-textSecondary">تدفقات واردة</span>
                    <span className="text-green-700 font-medium" dir="ltr">{formatCurrency(data.investingInflow, locale)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-textSecondary">تدفقات صادرة</span>
                    <span className="text-red-600 font-medium" dir="ltr">{formatCurrency(data.investingOutflow, locale)}</span>
                  </div>
                  <div className={"flex justify-between font-bold border-t pt-1 " + (parseFloat(data.netInvesting) >= 0 ? "text-green-700" : "text-red-600")}>
                    <span>صافي الاستثمار</span>
                    <span dir="ltr">{formatCurrency(data.netInvesting, locale)}</span>
                  </div>
                </div>
              </CardBody>
            </Card>

            {/* Other / Financing */}
            <Card>
              <CardHeader><CardTitle>أنشطة أخرى / تمويلية</CardTitle></CardHeader>
              <CardBody>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-textSecondary">تدفقات واردة</span>
                    <span className="text-green-700 font-medium" dir="ltr">{formatCurrency(data.otherInflow, locale)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-textSecondary">تدفقات صادرة</span>
                    <span className="text-red-600 font-medium" dir="ltr">{formatCurrency(data.otherOutflow, locale)}</span>
                  </div>
                  <div className={"flex justify-between font-bold border-t pt-1 " + (parseFloat(data.netOther) >= 0 ? "text-green-700" : "text-red-600")}>
                    <span>صافي الأخرى</span>
                    <span dir="ltr">{formatCurrency(data.netOther, locale)}</span>
                  </div>
                </div>
              </CardBody>
            </Card>
          </div>

          {/* Net cash flow banner */}
          <div className={"rounded-lg p-4 text-center font-bold text-lg " + (parseFloat(data.netCashFlow) >= 0 ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200")}>
            صافي التدفق النقدي ({data.from} → {data.to}):{" "}
            <span dir="ltr">{formatCurrency(data.netCashFlow, locale)}</span>
          </div>

          {/* Detail lines */}
          {data.lines.length > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>تفاصيل الحركات النقدية</CardTitle>
                  <button
                    type="button"
                    onClick={() => setExpandLines((v) => !v)}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    {expandLines ? "إخفاء التفاصيل" : "عرض التفاصيل"}
                  </button>
                </div>
              </CardHeader>
              {expandLines && (
                <CardBody className="p-0 overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>التاريخ</TH>
                        <TH>البيان</TH>
                        <TH>الحساب</TH>
                        <TH>وارد</TH>
                        <TH>صادر</TH>
                        <TH>صافي</TH>
                        <TH>التصنيف</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {data.lines.map((l, idx) => {
                        const net = parseFloat(l.net);
                        const catLabel: Record<string, string> = {
                          operating: "تشغيل",
                          investing: "استثمار",
                          other:     "أخرى",
                        };
                        const catColor: Record<string, string> = {
                          operating: "bg-blue-100 text-blue-800",
                          investing: "bg-purple-100 text-purple-800",
                          other:     "bg-gray-100 text-gray-700",
                        };
                        return (
                          <TR key={idx}>
                            <TD>{formatDate(l.date, locale)}</TD>
                            <TD className="max-w-[200px] truncate" title={l.description}>{l.description}</TD>
                            <TD className="text-xs">{l.accountCode} — {l.accountNameAr}</TD>
                            <TD dir="ltr" className="text-green-700">{parseFloat(l.debit) > 0 ? formatCurrency(l.debit, locale) : "—"}</TD>
                            <TD dir="ltr" className="text-red-600">{parseFloat(l.credit) > 0 ? formatCurrency(l.credit, locale) : "—"}</TD>
                            <TD dir="ltr" className={"font-semibold " + (net >= 0 ? "text-green-700" : "text-red-600")}>
                              {formatCurrency(l.net, locale)}
                            </TD>
                            <TD>
                              <span className={"inline-flex rounded px-1.5 py-0.5 text-xs font-medium " + (catColor[l.category] ?? "")}>
                                {catLabel[l.category] ?? l.category}
                              </span>
                            </TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                </CardBody>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
