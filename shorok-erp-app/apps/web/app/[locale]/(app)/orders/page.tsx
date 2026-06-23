"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { OrderStatus } from "@shorok/shared";
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
import { listOrders, deleteOrder, type OrderListRow } from "../../../../lib/orders-client";
import { formatCurrency, formatDate } from "../../../../lib/format";
import { useCurrentUser } from "../../../../lib/auth";

const STATUSES: Array<OrderStatus | "ALL"> = [
  "ALL",
  "DRAFT",
  "PENDING_PRICE_APPROVAL",
  "CONFIRMED",
  "PARTIALLY_COLLECTED",
  "PAID",
  "CANCELLED",
];

const STATUS_BADGE: Record<
  OrderStatus,
  "neutral" | "info" | "warning" | "success" | "danger"
> = {
  DRAFT: "neutral",
  PENDING_PRICE_APPROVAL: "warning",
  CONFIRMED: "info",
  PARTIALLY_COLLECTED: "info",
  PAID: "success",
  CANCELLED: "danger",
};

export default function OrdersPage() {
  const t = useTranslations("orders");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const user = useCurrentUser();
  const [branchId, setBranchId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "ALL">("ALL");
  const [rows, setRows] = useState<OrderListRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const isOwner = user?.role === "OWNER";

  const handleDelete = async () => {
    if (!deletingId) return;
    setDeleteLoading(true);
    try {
      await deleteOrder(deletingId);
      setRows((prev) => prev.filter((r) => r.id !== deletingId));
      setDeletingId(null);
    } catch {
      setError(tCommon("actionFailed"));
    } finally {
      setDeleteLoading(false);
    }
  };

  useEffect(() => {
    if (!branchId) {
      setRows([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void listOrders({
      branchId,
      status: statusFilter === "ALL" ? undefined : statusFilter,
    })
      .then((page) => {
        if (alive) setRows(page.data);
      })
      .catch((err) => {
        if (alive && err instanceof ApiClientError) setError(err.localizedMessage(locale));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [branchId, statusFilter, locale]);

  const canCreate = user?.role && ["OWNER", "BRANCH_MANAGER"].includes(user.role);

  return (
    <div className="space-y-section">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-page-title">{t("title")}</h1>
        <div className="flex items-center gap-3">
          <BranchPicker value={branchId} onChange={setBranchId} />
          <select
            aria-label={t("filters.status")}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as OrderStatus | "ALL")}
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === "ALL" ? t("filters.all") : t(`status.${s}`)}
              </option>
            ))}
          </select>
          {canCreate && branchId ? (
            <Link href={`/${locale}/orders/new?branchId=${branchId}`}>
              <Button>{t("create")}</Button>
            </Link>
          ) : null}
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
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !branchId ? (
            <EmptyState title={t("branchPicker")} />
          ) : rows.length === 0 ? (
            <EmptyState title={t("empty")} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH dir="ltr">{t("columns.date")}</TH>
                  <TH>{t("columns.customer")}</TH>
                  <TH>{t("columns.product")}</TH>
                  <TH dir="ltr" className="text-end">
                    {t("columns.boards")}
                  </TH>
                  <TH dir="ltr" className="text-end">
                    {t("columns.required")}
                  </TH>
                  <TH dir="ltr" className="text-end">
                    {t("columns.collected")}
                  </TH>
                  <TH dir="ltr" className="text-end">
                    {t("columns.remaining")}
                  </TH>
                  <TH>{t("columns.status")}</TH>
                  {isOwner ? <TH className="w-28"></TH> : null}
                </TR>
              </THead>
              <TBody>
                {rows.map((o) => {
                  const isDeleting = deletingId === o.id;
                  return (
                    <TR key={o.id}>
                      <TD dir="ltr">{formatDate(o.orderDate, locale)}</TD>
                      <TD>
                        <Link
                          href={`/${locale}/orders/${o.id}`}
                          className="text-info hover:underline"
                        >
                          {o.customerName}
                        </Link>
                      </TD>
                      <TD>
                        {locale === "ar"
                          ? o.productVariant.sku.colorNameAr
                          : o.productVariant.sku.colorNameEn}{" "}
                        <span dir="ltr" className="text-textSecondary">
                          · {o.productVariant.sku.code} ·{" "}
                          {o.productVariant.sizeMetersPerBoard}m
                        </span>
                      </TD>
                      <TD dir="ltr" className="text-end">
                        {o.boardsQuantity}
                      </TD>
                      <TD dir="ltr" className="text-end font-medium">
                        {formatCurrency(o.requiredAmount, locale)}
                      </TD>
                      <TD dir="ltr" className="text-end">
                        {formatCurrency(o.collectedAmount, locale)}
                      </TD>
                      <TD dir="ltr" className="text-end">
                        {formatCurrency(o.remainingAmount, locale)}
                      </TD>
                      <TD>
                        <Badge variant={STATUS_BADGE[o.status]}>{t(`status.${o.status}`)}</Badge>
                      </TD>
                      {isOwner ? (
                        <TD>
                          {isDeleting ? (
                            <span className="flex items-center gap-2 text-xs">
                              <span className="text-error">{tCommon("deleteConfirm")}</span>
                              <button
                                onClick={() => void handleDelete()}
                                disabled={deleteLoading}
                                className="text-error font-medium hover:underline disabled:opacity-50"
                              >
                                {tCommon("yes")}
                              </button>
                              <button
                                onClick={() => setDeletingId(null)}
                                className="text-textSecondary hover:underline"
                              >
                                {tCommon("no")}
                              </button>
                            </span>
                          ) : (
                            <button
                              title={tCommon("delete")}
                              onClick={() => setDeletingId(o.id)}
                              className="text-base"
                            >
                              🗑️
                            </button>
                          )}
                        </TD>
                      ) : null}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
