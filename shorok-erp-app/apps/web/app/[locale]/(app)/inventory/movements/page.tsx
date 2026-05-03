"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import type { MovementType } from "@shorok/shared";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { EmptyState } from "../../../../../components/ui/empty-state";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { BranchPicker } from "../../../../../components/features/inventory/branch-picker";
import { ApiClientError } from "../../../../../lib/api-client";
import { listMovements, type MovementRow } from "../../../../../lib/inventory-client";
import { formatDateTime, formatNumber } from "../../../../../lib/format";

const TYPES: Array<MovementType | "ALL"> = [
  "ALL",
  "RECEIPT",
  "SALE",
  "ADJUSTMENT",
  "COUNT_CORRECTION",
];

const typeBadge: Record<MovementType, "info" | "success" | "warning" | "neutral"> = {
  RECEIPT: "success",
  SALE: "info",
  ADJUSTMENT: "warning",
  COUNT_CORRECTION: "neutral",
};

export default function MovementsPage() {
  const t = useTranslations("inventory.movementsPage");
  const tInv = useTranslations("inventory");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const params = useSearchParams();

  const [branchId, setBranchId] = useState<string | null>(params.get("branchId"));
  const [type, setType] = useState<MovementType | "ALL">("ALL");
  const [rows, setRows] = useState<MovementRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!branchId) {
      setRows([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void listMovements({
      branchId,
      movementType: type === "ALL" ? undefined : type,
    })
      .then((page) => {
        if (!alive) return;
        setRows(page.data);
        setCursor(page.nextCursor);
      })
      .catch((err) => {
        if (alive && err instanceof ApiClientError) setError(err.localizedMessage(locale));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [branchId, type, locale]);

  async function loadMore() {
    if (!branchId || !cursor) return;
    setLoadingMore(true);
    try {
      const page = await listMovements({
        branchId,
        movementType: type === "ALL" ? undefined : type,
        cursor,
      });
      setRows((prev) => [...prev, ...page.data]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-section">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-page-title">{t("title")}</h1>
        <div className="flex items-center gap-3">
          <BranchPicker value={branchId} onChange={setBranchId} />
          <select
            aria-label={t("filters.type")}
            value={type}
            onChange={(e) => setType(e.target.value as MovementType | "ALL")}
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
          >
            {TYPES.map((opt) => (
              <option key={opt} value={opt}>
                {opt === "ALL" ? t("filters.all") : opt}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardBody>
          {error ? (
            <Alert variant="error" className="mb-3">
              {error}
            </Alert>
          ) : null}

          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title={t("empty")} />
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH dir="ltr">{t("columns.date")}</TH>
                    <TH>{t("columns.type")}</TH>
                    <TH>{tInv("color")}</TH>
                    <TH dir="ltr">{tInv("code")}</TH>
                    <TH dir="ltr">{tInv("size")}</TH>
                    <TH dir="ltr" className="text-end">
                      {t("columns.boards")}
                    </TH>
                    <TH dir="ltr" className="text-end">
                      {t("columns.meters")}
                    </TH>
                    <TH>{t("columns.actor")}</TH>
                    <TH>{t("columns.note")}</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((m) => (
                    <TR key={m.id}>
                      <TD dir="ltr">{formatDateTime(m.createdAt, locale)}</TD>
                      <TD>
                        <Badge variant={typeBadge[m.movementType]}>{m.movementType}</Badge>
                      </TD>
                      <TD>
                        {locale === "ar"
                          ? m.productVariant.sku.colorNameAr
                          : m.productVariant.sku.colorNameEn}
                      </TD>
                      <TD dir="ltr">{m.productVariant.sku.code}</TD>
                      <TD dir="ltr">{m.productVariant.sizeMetersPerBoard} m</TD>
                      <TD dir="ltr" className="text-end font-medium">
                        {formatNumber(m.boardsQuantity, locale)}
                      </TD>
                      <TD dir="ltr" className="text-end">
                        {formatNumber(m.metersQuantity, locale)}
                      </TD>
                      <TD>{m.creator.name}</TD>
                      <TD>{m.humanReadableNote ?? "—"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>

              {cursor ? (
                <div className="mt-4 flex justify-center">
                  <Button variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? tCommon("loading") : tCommon("loadMore")}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
