"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../i18n";
import { Alert } from "../../../../components/ui/alert";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui/card";
import { EmptyState } from "../../../../components/ui/empty-state";
import { Skeleton } from "../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { BranchPicker } from "../../../../components/features/inventory/branch-picker";
import { ApiClientError } from "../../../../lib/api-client";
import {
  listBalances,
  listMovements,
  type BalanceRow,
  type MovementRow,
} from "../../../../lib/inventory-client";
import { formatDate, formatDateTime, formatNumber } from "../../../../lib/format";
import { useCurrentUser } from "../../../../lib/auth";

export default function InventoryPage() {
  const t = useTranslations("inventory");
  const locale = useLocale() as AppLocale;
  const user = useCurrentUser();
  const [branchId, setBranchId] = useState<string | null>(null);
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [recentMovements, setRecentMovements] = useState<MovementRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (b: string) => {
    setLoading(true);
    setError(null);
    try {
      const [balances, movements] = await Promise.all([
        listBalances(b),
        listMovements({ branchId: b, limit: 5 }),
      ]);
      setRows(balances.data);
      setRecentMovements(movements.data);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.localizedMessage(locale) : null);
      setRows([]);
      setRecentMovements([]);
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => {
    if (branchId) void load(branchId);
  }, [branchId, load]);

  const canWrite = user?.role && ["OWNER", "BRANCH_MANAGER", "WAREHOUSE"].includes(user.role);

  return (
    <div className="space-y-section">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-page-title">{t("title")}</h1>
        <BranchPicker value={branchId} onChange={setBranchId} />
      </div>

      {canWrite && branchId ? (
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/${locale}/inventory/receipts/new?branchId=${branchId}`}>
            <Button>{t("actions.receive")}</Button>
          </Link>
          <Link href={`/${locale}/inventory/adjustments/new?branchId=${branchId}`}>
            <Button variant="secondary">{t("actions.adjust")}</Button>
          </Link>
          <Link href={`/${locale}/inventory/counts/new?branchId=${branchId}`}>
            <Button variant="secondary">{t("actions.count")}</Button>
          </Link>
          <Link href={`/${locale}/inventory/movements?branchId=${branchId}`}>
            <Button variant="ghost">{t("actions.viewMovements")}</Button>
          </Link>
        </div>
      ) : null}

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
          ) : !branchId ? (
            <EmptyState title={t("branchPicker")} />
          ) : rows.length === 0 ? (
            <EmptyState title={t("noBalances")} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{t("color")}</TH>
                  <TH>{t("code")}</TH>
                  <TH>{t("size")}</TH>
                  <TH dir="ltr" className="text-end">
                    {t("boards")}
                  </TH>
                  <TH dir="ltr" className="text-end">
                    {t("meters")}
                  </TH>
                  <TH>{t("lastCounted")}</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row.productVariantId}>
                    <TD>{locale === "ar" ? row.sku.colorNameAr : row.sku.colorNameEn}</TD>
                    <TD dir="ltr">{row.sku.code}</TD>
                    <TD dir="ltr">{row.sizeMetersPerBoard} m</TD>
                    <TD dir="ltr" className="text-end font-medium">
                      {formatNumber(row.boardsOnHand, locale)}
                    </TD>
                    <TD dir="ltr" className="text-end">
                      {formatNumber(row.metersOnHand, locale)}
                    </TD>
                    <TD dir="ltr">
                      {row.lastCountedAt ? formatDate(row.lastCountedAt, locale) : "—"}
                    </TD>
                    <TD>{row.lowStock ? <Badge variant="warning">{t("lowStock")}</Badge> : null}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {branchId && !loading && recentMovements.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("movements")}</CardTitle>
            <Link href={`/${locale}/inventory/movements?branchId=${branchId}`}>
              <Button variant="ghost" size="sm">
                {t("actions.viewMovements")}
              </Button>
            </Link>
          </CardHeader>
          <CardBody>
            <Table>
              <THead>
                <TR>
                  <TH dir="ltr">{t("movementsPage.columns.date")}</TH>
                  <TH>{t("movementsPage.columns.type")}</TH>
                  <TH>{t("color")}</TH>
                  <TH dir="ltr">{t("code")}</TH>
                  <TH dir="ltr" className="text-end">
                    {t("movementsPage.columns.boards")}
                  </TH>
                  <TH>{t("movementsPage.columns.actor")}</TH>
                </TR>
              </THead>
              <TBody>
                {recentMovements.map((m) => (
                  <TR key={m.id}>
                    <TD dir="ltr">{formatDateTime(m.createdAt, locale)}</TD>
                    <TD>
                      <Badge variant="neutral">{m.movementType}</Badge>
                    </TD>
                    <TD>
                      {locale === "ar"
                        ? m.productVariant.sku.colorNameAr
                        : m.productVariant.sku.colorNameEn}
                    </TD>
                    <TD dir="ltr">{m.productVariant.sku.code}</TD>
                    <TD dir="ltr" className="text-end font-medium">
                      {formatNumber(m.boardsQuantity, locale)}
                    </TD>
                    <TD>{m.creator.name}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
