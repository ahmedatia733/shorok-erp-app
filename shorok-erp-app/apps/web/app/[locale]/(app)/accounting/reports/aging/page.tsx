"use client";

import { useState } from "react";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import {
  getAging,
  type AgingData,
  type AgingRow,
} from "../../../../../../lib/reports-client";

const today = new Date().toISOString().slice(0, 10);

type ReportType = "AR" | "AP";

function fmt(v: string): string {
  const n = parseFloat(v);
  if (n === 0) return "—";
  return n.toLocaleString("ar-EG", { minimumFractionDigits: 2 });
}

function AmtCell({ v, bold }: { v: string; bold?: boolean }) {
  const n = parseFloat(v);
  return (
    <TD dir="ltr" className={`text-end ${bold ? "font-bold" : ""}`}>
      {n === 0 ? <span className="text-textSecondary">—</span> : fmt(v)}
    </TD>
  );
}

export default function AgingPage() {
  const [reportType, setReportType] = useState<ReportType>("AR");
  const [asOf, setAsOf] = useState(today);
  const [data, setData] = useState<AgingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLoad(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await getAging(reportType, asOf);
      setData(result);
    } catch {
      setError("حدث خطأ أثناء تحميل تقرير عمر الديون");
    } finally {
      setLoading(false);
    }
  }

  // Reset data when switching type
  function switchType(t: ReportType) {
    setReportType(t);
    setData(null);
    setError(null);
  }

  const arLabel = "مديونية العملاء (AR)";
  const apLabel = "مديونية الموردين (AP)";

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold">تقرير عمر الديون</h1>
        {data && (
          <Button variant="ghost" size="sm" onClick={() => window.print()}>
            طباعة
          </Button>
        )}
      </div>

      {/* Type switcher + filters */}
      <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
        {/* AR / AP tabs */}
        <div className="flex gap-2">
          {(["AR", "AP"] as ReportType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => switchType(t)}
              className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                reportType === t
                  ? "bg-primary text-white border-primary"
                  : "border-border hover:bg-background"
              }`}
            >
              {t === "AR" ? arLabel : apLabel}
            </button>
          ))}
        </div>

        {/* Filter row */}
        <form
          onSubmit={(e) => void handleLoad(e)}
          className="flex items-end gap-3 flex-wrap"
        >
          <div>
            <label className="block text-xs text-textSecondary mb-1">حتى تاريخ</label>
            <input
              type="date"
              className="border border-border rounded-md px-3 py-2 text-sm bg-background"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? "جار التحميل..." : "عرض"}
          </Button>
        </form>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {loading && (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      )}

      {data && !loading && (
        <div className="print:text-xs">
          <div className="text-sm text-textSecondary mb-2">
            {data.type === "AR" ? arLabel : apLabel} — حتى تاريخ: {data.asOf}
          </div>

          <Table>
            <THead>
              <TR>
                <TH className="w-24">الكود</TH>
                <TH>الاسم</TH>
                <TH className="text-end">إجمالي المطلوب</TH>
                <TH className="text-end">{data.type === "AR" ? "المحصّل" : "المدفوع"}</TH>
                <TH className="text-end">الرصيد المستحق</TH>
                <TH className="text-end">جاري (0-30)</TH>
                <TH className="text-end">31-60 يوم</TH>
                <TH className="text-end">61-90 يوم</TH>
                <TH className="text-end">+90 يوم</TH>
              </TR>
            </THead>
            <TBody>
              {data.rows.length === 0 ? (
                <TR>
                  <TD colSpan={9} className="text-center text-textSecondary py-8">
                    لا توجد ديون مستحقة
                  </TD>
                </TR>
              ) : (
                <>
                  {data.rows.map((row: AgingRow) => (
                    <TR key={row.entityId}>
                      <TD className="font-mono text-xs">{row.code || "—"}</TD>
                      <TD>{row.nameAr}</TD>
                      <AmtCell v={row.totalInvoiced} />
                      <AmtCell v={row.totalReceived} />
                      <TD dir="ltr" className="text-end font-medium text-red-600">
                        {fmt(row.outstanding)}
                      </TD>
                      <AmtCell v={row.current} />
                      <AmtCell v={row.days30} />
                      <AmtCell v={row.days60} />
                      <AmtCell v={row.days90plus} />
                    </TR>
                  ))}

                  {/* Totals row */}
                  <TR className="bg-background border-t-2 border-border font-bold">
                    <TD colSpan={2} className="font-bold">
                      الإجمالي
                    </TD>
                    <TD />
                    <TD />
                    <TD dir="ltr" className="text-end font-bold text-red-600">
                      {fmt(data.totals.outstanding)}
                    </TD>
                    <AmtCell v={data.totals.current} bold />
                    <AmtCell v={data.totals.days30} bold />
                    <AmtCell v={data.totals.days60} bold />
                    <AmtCell v={data.totals.days90plus} bold />
                  </TR>
                </>
              )}
            </TBody>
          </Table>
        </div>
      )}

      {!data && !loading && !error && (
        <p className="text-textSecondary text-sm">
          {"اختر النوع والتاريخ ثم اضغط \"عرض\" لعرض التقرير"}
        </p>
      )}
    </div>
  );
}
