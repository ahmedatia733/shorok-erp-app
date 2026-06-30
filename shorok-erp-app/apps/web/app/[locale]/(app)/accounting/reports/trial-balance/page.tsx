"use client";

import { useState } from "react";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import {
  getTrialBalance,
  type TrialBalanceData,
  type TrialBalanceRow,
} from "../../../../../../lib/reports-client";

const today = new Date().toISOString().slice(0, 10);
const firstOfYear = today.slice(0, 4) + "-01-01";

function fmt(v: string): string {
  const n = parseFloat(v);
  if (n === 0) return "—";
  return n.toLocaleString("ar-EG", { minimumFractionDigits: 2 });
}

function AmountCell({ v, bold }: { v: string; bold?: boolean }) {
  const n = parseFloat(v);
  return (
    <TD dir="ltr" className={bold ? "font-bold text-end" : "text-end"}>
      {n === 0 ? <span className="text-textSecondary">—</span> : fmt(v)}
    </TD>
  );
}

export default function TrialBalancePage() {
  const [from, setFrom] = useState(firstOfYear);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<TrialBalanceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLoad(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await getTrialBalance(from, to);
      setData(result);
    } catch {
      setError("حدث خطأ أثناء تحميل ميزان المراجعة");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold">ميزان المراجعة</h1>
        {data && (
          <Button variant="ghost" size="sm" onClick={() => window.print()}>
            طباعة
          </Button>
        )}
      </div>

      {/* Filters */}
      <form
        onSubmit={(e) => void handleLoad(e)}
        className="bg-surface border border-border rounded-lg p-4 flex items-end gap-3 flex-wrap"
      >
        <div>
          <label className="block text-xs text-textSecondary mb-1">من تاريخ</label>
          <input
            type="date"
            className="border border-border rounded-md px-3 py-2 text-sm bg-background"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-xs text-textSecondary mb-1">إلى تاريخ</label>
          <input
            type="date"
            className="border border-border rounded-md px-3 py-2 text-sm bg-background"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={loading}>
          {loading ? "جار التحميل..." : "عرض"}
        </Button>
      </form>

      {error && <Alert variant="error">{error}</Alert>}

      {loading && (
        <div className="space-y-2">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      )}

      {data && !loading && (
        <div className="print:text-xs">
          <div className="text-sm text-textSecondary mb-2">
            الفترة: {data.from} — {data.to}
          </div>
          <Table>
            <THead>
              <TR>
                <TH className="w-20">الكود</TH>
                <TH>اسم الحساب</TH>
                <TH className="text-end">رصيد أول المدة (مدين)</TH>
                <TH className="text-end">رصيد أول المدة (دائن)</TH>
                <TH className="text-end">حركة المدة (مدين)</TH>
                <TH className="text-end">حركة المدة (دائن)</TH>
                <TH className="text-end">رصيد آخر المدة (مدين)</TH>
                <TH className="text-end">رصيد آخر المدة (دائن)</TH>
              </TR>
            </THead>
            <TBody>
              {data.rows.length === 0 ? (
                <TR>
                  <TD colSpan={8} className="text-center text-textSecondary py-8">
                    لا توجد بيانات في هذه الفترة
                  </TD>
                </TR>
              ) : (
                <>
                  {data.rows.map((row: TrialBalanceRow) => (
                    <TR key={row.accountId}>
                      <TD className="font-mono text-xs">{row.code}</TD>
                      <TD>{row.nameAr}</TD>
                      <AmountCell v={row.openingDebit} />
                      <AmountCell v={row.openingCredit} />
                      <AmountCell v={row.periodDebit} />
                      <AmountCell v={row.periodCredit} />
                      <AmountCell v={row.closingDebit} />
                      <AmountCell v={row.closingCredit} />
                    </TR>
                  ))}

                  {/* Totals row */}
                  <TR className="bg-background font-bold border-t-2 border-border">
                    <TD colSpan={2} className="font-bold">
                      الإجمالي
                    </TD>
                    <AmountCell v={data.totals.openingDebit} bold />
                    <AmountCell v={data.totals.openingCredit} bold />
                    <AmountCell v={data.totals.periodDebit} bold />
                    <AmountCell v={data.totals.periodCredit} bold />
                    <AmountCell v={data.totals.closingDebit} bold />
                    <AmountCell v={data.totals.closingCredit} bold />
                  </TR>
                </>
              )}
            </TBody>
          </Table>
        </div>
      )}

      {!data && !loading && !error && (
        <p className="text-textSecondary text-sm">{"اختر الفترة واضغط \"عرض\" لتحميل الميزان"}</p>
      )}
    </div>
  );
}
