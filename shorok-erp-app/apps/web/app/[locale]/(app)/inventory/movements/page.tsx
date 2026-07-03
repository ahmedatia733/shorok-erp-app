"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { MovementType } from "@shorok/shared";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { EmptyState } from "../../../../../components/ui/empty-state";
import { Input } from "../../../../../components/ui/input";
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

const typeLabel: Record<MovementType, string> = {
  RECEIPT: "إيراد مخزون",
  SALE: "بيع",
  ADJUSTMENT: "تسوية",
  COUNT_CORRECTION: "تصحيح جرد",
};

export default function MovementsPage() {
  const t = useTranslations("inventory.movementsPage");
  const tInv = useTranslations("inventory");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;

  const [branchId,     setBranchId]     = useState<string | null>(null);
  const [referenceId,  setReferenceId]  = useState<string | null>(null);
  const [referenceType,setReferenceType]= useState<string | null>(null);
  const [type, setType] = useState<MovementType | "ALL">("ALL");
  const [rows, setRows] = useState<MovementRow[]>([]);
  const [listSearch, setListSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read URL params on mount (avoids SSR hydration mismatch)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const bid = p.get("branchId");
    const rid = p.get("referenceId");
    const rtype = p.get("referenceType");
    if (bid)   setBranchId(bid);
    if (rid)   setReferenceId(rid);
    if (rtype) setReferenceType(rtype);
  }, []);

  const canLoad = !!(branchId || referenceId);

  useEffect(() => {
    if (!canLoad) {
      setRows([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void listMovements({
      branchId:      branchId    ?? undefined,
      referenceId:   referenceId  ?? undefined,
      referenceType: referenceType ?? undefined,
      movementType:  type === "ALL" ? undefined : type,
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
    return () => { alive = false; };
  }, [branchId, referenceId, referenceType, type, locale, canLoad]);

  async function loadMore() {
    if (!canLoad || !cursor) return;
    setLoadingMore(true);
    try {
      const page = await listMovements({
        branchId:      branchId    ?? undefined,
        referenceId:   referenceId  ?? undefined,
        referenceType: referenceType ?? undefined,
        movementType:  type === "ALL" ? undefined : type,
        cursor,
      });
      setRows((prev) => [...prev, ...page.data]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  function clearReferenceFilter() {
    setReferenceId(null);
    setReferenceType(null);
    // Remove from URL without navigation
    const url = new URL(window.location.href);
    url.searchParams.delete("referenceId");
    url.searchParams.delete("referenceType");
    window.history.replaceState(null, "", url.toString());
  }

  const displayedRows = listSearch
    ? rows.filter((m) =>
        (m.productVariant.sku.colorNameAr + " " + m.productVariant.sku.code + " " + (m.humanReadableNote ?? ""))
          .toLowerCase()
          .includes(listSearch.toLowerCase())
      )
    : rows;

  const isFiltered = !!referenceId;
  const refLabel = referenceType === "purchase_invoice"
    ? "فاتورة مشتريات"
    : referenceType === "sales_invoice"
    ? "فاتورة مبيعات"
    : referenceType ?? "";

  return (
    <div className="space-y-section" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-page-title">{t("title")}</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <BranchPicker value={branchId} onChange={setBranchId} />
          <select
            aria-label={t("filters.type")}
            value={type}
            onChange={(e) => setType(e.target.value as MovementType | "ALL")}
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
          >
            {TYPES.map((opt) => (
              <option key={opt} value={opt}>
                {opt === "ALL" ? t("filters.all") : (typeLabel[opt as MovementType] ?? opt)}
              </option>
            ))}
          </select>
          <Input placeholder="بحث هنا..." value={listSearch} onChange={(e) => setListSearch(e.target.value)} className="max-w-xs border-2 border-primary/40 bg-background" />
          {listSearch && <button type="button" className="text-xs text-textSecondary hover:text-text" onClick={() => setListSearch("")}>مسح ✕</button>}
        </div>
      </div>

      {/* Reference filter banner */}
      {isFiltered && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm" dir="rtl">
          <span className="text-blue-800">
            عرض حركات مخزون مرتبطة بـ <strong>{refLabel}</strong>
            {referenceId && (
              <span className="ms-2 font-mono text-xs text-blue-500">#{referenceId.slice(0, 8)}</span>
            )}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearReferenceFilter}
            className="text-blue-700 hover:text-blue-900 shrink-0"
          >
            عرض كل الحركات ×
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardBody>
          {error ? (
            <Alert variant="error" className="mb-3">{error}</Alert>
          ) : null}

          {!canLoad ? (
            <EmptyState title="اختر فرعاً لعرض الحركات" />
          ) : loading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : displayedRows.length === 0 ? (
            <EmptyState title={t("empty")} />
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH dir="ltr">{t("columns.date")}</TH>
                    <TH>النوع</TH>
                    <TH>{tInv("color")}</TH>
                    <TH dir="ltr">{tInv("code")}</TH>
                    <TH dir="ltr">{tInv("size")}</TH>
                    <TH dir="ltr" className="text-end">{t("columns.boards")}</TH>
                    <TH dir="ltr" className="text-end">{t("columns.meters")}</TH>
                    <TH>{t("columns.actor")}</TH>
                    <TH>{t("columns.note")}</TH>
                  </TR>
                </THead>
                <TBody>
                  {displayedRows.map((m) => (
                    <TR key={m.id}>
                      <TD dir="ltr">{formatDateTime(m.createdAt, locale)}</TD>
                      <TD>
                        <Badge variant={typeBadge[m.movementType]}>
                          {typeLabel[m.movementType] ?? m.movementType}
                        </Badge>
                      </TD>
                      <TD>
                        {locale === "ar"
                          ? m.productVariant.sku.colorNameAr
                          : m.productVariant.sku.colorNameEn}
                      </TD>
                      <TD dir="ltr">{m.productVariant.sku.code}</TD>
                      <TD dir="ltr">{m.productVariant.sizeMetersPerBoard} م²</TD>
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
                  <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
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
