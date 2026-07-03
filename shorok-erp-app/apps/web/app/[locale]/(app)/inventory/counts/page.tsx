"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { EmptyState } from "../../../../../components/ui/empty-state";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { BranchPicker } from "../../../../../components/features/inventory/branch-picker";
import { ApiClientError } from "../../../../../lib/api-client";
import { listMovements, type MovementRow } from "../../../../../lib/inventory-client";
import { formatDateTime, formatNumber } from "../../../../../lib/format";

export default function CountsListPage() {
  const locale = useLocale() as AppLocale;
  const [branchId, setBranchId] = useState<string | null>(null);
  const [rows, setRows]         = useState<MovementRow[]>([]);
  const [cursor, setCursor]     = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    if (!branchId) { setRows([]); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    setCursor(null);
    void listMovements({ branchId, movementType: "COUNT_CORRECTION" })
      .then((p) => { if (alive) { setRows(p.data); setCursor(p.nextCursor); } })
      .catch((err) => { if (alive && err instanceof ApiClientError) setError(err.localizedMessage(locale)); })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [branchId, locale]);

  async function loadMore() {
    if (!branchId || !cursor) return;
    setLoadingMore(true);
    try {
      const p = await listMovements({ branchId, movementType: "COUNT_CORRECTION", cursor });
      setRows((prev) => [...prev, ...p.data]);
      setCursor(p.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-bold">الجرد اليومي</h1>
        <div className="flex items-center gap-3">
          <BranchPicker value={branchId} onChange={setBranchId} />
          {branchId && (
            <Link href={`/${locale}/inventory/counts/new?branchId=${branchId}`}>
              <Button>+ جرد جديد</Button>
            </Link>
          )}
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {loading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : !branchId ? (
        <EmptyState title="اختر الفرع أولاً" />
      ) : rows.length === 0 ? (
        <EmptyState title="لا توجد عمليات جرد لهذا الفرع" />
      ) : (
        <>
          <div className="border border-border rounded overflow-hidden">
            <Table>
              <THead>
                <TR>
                  <TH>التاريخ والوقت</TH>
                  <TH>المنتج</TH>
                  <TH className="text-end">الفرق (ألواح)</TH>
                  <TH className="text-end">الفرق (م)</TH>
                  <TH>البيان</TH>
                  <TH>بواسطة</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((m) => {
                  const boards = parseFloat(m.boardsQuantity);
                  const meters = parseFloat(m.metersQuantity);
                  return (
                    <TR key={m.id}>
                      <TD className="text-sm whitespace-nowrap">
                        {formatDateTime(m.createdAt, locale)}
                      </TD>
                      <TD className="text-sm">
                        {locale === "ar"
                          ? m.productVariant.sku.colorNameAr
                          : m.productVariant.sku.colorNameEn}
                        <span className="text-xs text-textSecondary ms-1 font-mono">
                          {m.productVariant.sku.code} · {m.productVariant.sizeMetersPerBoard}م
                        </span>
                      </TD>
                      <TD className={`text-end tabular-nums font-medium ${boards > 0 ? "text-green-700" : boards < 0 ? "text-red-700" : "text-textSecondary"}`}>
                        {boards > 0 ? "+" : ""}{formatNumber(boards, locale)}
                      </TD>
                      <TD className={`text-end tabular-nums ${meters > 0 ? "text-green-700" : meters < 0 ? "text-red-700" : "text-textSecondary"}`}>
                        {meters > 0 ? "+" : ""}{formatNumber(meters, locale)}
                      </TD>
                      <TD className="text-sm text-textSecondary max-w-xs truncate">
                        {m.humanReadableNote ?? "—"}
                      </TD>
                      <TD className="text-sm">{m.creator?.name ?? "—"}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>

          {cursor && (
            <div className="text-center">
              <Button variant="ghost" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "جار التحميل..." : "تحميل المزيد"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
