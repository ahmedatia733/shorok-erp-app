"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { EmptyState } from "../../../../../components/ui/empty-state";
import { Input } from "../../../../../components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { useHasRole } from "../../../../../lib/auth";
import { formatDate, formatNumber } from "../../../../../lib/format";
import {
  listTransfers,
  type InventoryTransferStatus,
  type TransferListRow,
} from "../../../../../lib/inventory-transfers-client";

const STATUS_AR: Record<InventoryTransferStatus, string> = {
  DRAFT: "مسودة",
  CONFIRMED: "مؤكد",
  CANCELLED: "ملغي",
};

const STATUS_VARIANT: Record<InventoryTransferStatus, "neutral" | "success" | "warning"> = {
  DRAFT: "neutral",
  CONFIRMED: "success",
  CANCELLED: "warning",
};

export default function InventoryTransfersPage() {
  const locale = useLocale() as AppLocale;
  const canCreate = useHasRole("OWNER");
  const [rows, setRows] = useState<TransferListRow[]>([]);
  const [status, setStatus] = useState<"" | InventoryTransferStatus>("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listTransfers({
        status: status || undefined,
        q: search.trim() || undefined,
        limit: 100,
      });
      setRows(res.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">تحويلات المخزون</h1>
        {canCreate && (
          <Link href={`/${locale}/inventory/transfers/new`}>
            <Button>إذن تحويل جديد</Button>
          </Link>
        )}
      </div>

      <Alert variant="info">
        التحويل ينقل ألواحًا كاملة بين المخازن فقط. إجمالي المخزون ومتوسط التكلفة لا يتغيران،
        ولا ينشأ عنه أي قيد محاسبي.
      </Alert>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>أذون التحويل</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="الحالة"
              value={status}
              onChange={(e) => setStatus(e.target.value as "" | InventoryTransferStatus)}
              className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
            >
              <option value="">كل الحالات</option>
              <option value="DRAFT">مسودة</option>
              <option value="CONFIRMED">مؤكد</option>
              <option value="CANCELLED">ملغي</option>
            </select>
            <Input
              aria-label="بحث"
              placeholder="رقم الإذن أو الصنف"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56"
            />
          </div>
        </CardHeader>
        <CardBody>
          {error && <Alert variant="error">{error}</Alert>}
          {loading ? (
            <p className="text-sm text-textSecondary">جارٍ التحميل…</p>
          ) : rows.length === 0 ? (
            <EmptyState title="لا توجد أذون تحويل" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>رقم الإذن</TH>
                  <TH>التاريخ</TH>
                  <TH>من مخزن</TH>
                  <TH>إلى مخزن</TH>
                  <TH>عدد البنود</TH>
                  <TH>إجمالي الألواح</TH>
                  <TH>إجمالي الأمتار</TH>
                  <TH>الحالة</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-mono">{r.transferNumber}</TD>
                    <TD>{formatDate(r.transferDate, locale)}</TD>
                    <TD>{r.sourceBranch.nameAr}</TD>
                    <TD>{r.destinationBranch.nameAr}</TD>
                    <TD>{r.lineCount}</TD>
                    <TD>{formatNumber(r.totalBoards, locale)}</TD>
                    <TD>{formatNumber(r.totalMeters, locale)}</TD>
                    <TD>
                      <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_AR[r.status]}</Badge>
                    </TD>
                    <TD>
                      <Link
                        href={`/${locale}/inventory/transfers/${r.id}`}
                        className="text-primary hover:underline"
                      >
                        عرض
                      </Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
