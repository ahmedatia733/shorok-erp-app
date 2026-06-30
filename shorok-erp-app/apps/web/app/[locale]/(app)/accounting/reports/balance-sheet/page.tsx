"use client";

import { useState } from "react";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import {
  getBalanceSheet,
  type BalanceSheetData,
  type BalanceSheetAccountRow,
} from "../../../../../../lib/reports-client";

const today = new Date().toISOString().slice(0, 10);

function fmt(v: string): string {
  const n = parseFloat(v);
  return n.toLocaleString("ar-EG", { minimumFractionDigits: 2 });
}

function AccountRowItem({ row }: { row: BalanceSheetAccountRow }) {
  return (
    <div className="flex justify-between items-center py-1.5 text-sm border-b border-border/40 last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-xs text-textSecondary shrink-0">{row.code}</span>
        <span className="truncate">{row.nameAr}</span>
      </div>
      <span dir="ltr" className="font-medium shrink-0 ps-3">
        {fmt(row.balance)}
      </span>
    </div>
  );
}

function Section({
  title,
  rows,
  total,
  totalLabel,
}: {
  title: string;
  rows: BalanceSheetAccountRow[];
  total: string;
  totalLabel: string;
}) {
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="bg-background px-4 py-2 font-bold text-sm border-b border-border">
        {title}
      </div>
      <div className="px-4 py-1">
        {rows.length === 0 ? (
          <p className="text-textSecondary text-sm py-3 text-center">لا توجد بنود</p>
        ) : (
          rows.map((r) => <AccountRowItem key={r.accountId} row={r} />)
        )}
      </div>
      <div className="flex justify-between items-center px-4 py-2 bg-background border-t border-border font-bold text-sm">
        <span>{totalLabel}</span>
        <span dir="ltr">{fmt(total)}</span>
      </div>
    </div>
  );
}

export default function BalanceSheetPage() {
  const [asOf, setAsOf] = useState(today);
  const [data, setData] = useState<BalanceSheetData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLoad(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await getBalanceSheet(asOf);
      setData(result);
    } catch {
      setError("حدث خطأ أثناء تحميل الميزانية العمومية");
    } finally {
      setLoading(false);
    }
  }

  const differenceNum = data ? parseFloat(data.difference) : 0;

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold">الميزانية العمومية</h1>
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

      {error && <Alert variant="error">{error}</Alert>}

      {loading && (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      )}

      {data && !loading && (
        <div className="space-y-4 print:text-xs">
          <p className="text-sm text-textSecondary">في تاريخ: {data.asOf}</p>

          {/* Balance out-of-balance warning */}
          {Math.abs(differenceNum) > 0.01 && (
            <Alert variant="error">
              تحذير: الميزانية غير متوازنة — الفرق: {fmt(data.difference)} ج.م
            </Alert>
          )}

          {/* Two-column layout on larger screens */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left: Assets */}
            <Section
              title="الأصول"
              rows={data.assets}
              total={data.totalAssets}
              totalLabel="إجمالي الأصول"
            />

            {/* Right: Liabilities + Equity stacked */}
            <div className="space-y-4">
              <Section
                title="الالتزامات"
                rows={data.liabilities}
                total={data.totalLiabilities}
                totalLabel="إجمالي الالتزامات"
              />
              <Section
                title="حقوق الملكية"
                rows={data.equity}
                total={data.totalEquity}
                totalLabel="إجمالي حقوق الملكية"
              />
            </div>
          </div>

          {/* Summary equation */}
          <div className="bg-surface border border-border rounded-lg p-4">
            <div className="flex justify-between items-center text-sm font-bold">
              <span>إجمالي الأصول</span>
              <span dir="ltr">{fmt(data.totalAssets)}</span>
            </div>
            <div className="flex justify-between items-center text-sm text-textSecondary mt-1">
              <span>إجمالي الالتزامات + حقوق الملكية</span>
              <span dir="ltr">
                {fmt(
                  (parseFloat(data.totalLiabilities) + parseFloat(data.totalEquity)).toFixed(2),
                )}
              </span>
            </div>
          </div>
        </div>
      )}

      {!data && !loading && !error && (
        <p className="text-textSecondary text-sm">{"اختر التاريخ واضغط \"عرض\" لتحميل الميزانية"}</p>
      )}
    </div>
  );
}
