"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { AuditTail } from "../../../../../components/features/audit/audit-tail";
import { CollectionDrawer } from "../../../../../components/features/orders/collection-drawer";
import { ApiClientError } from "../../../../../lib/api-client";
import {
  approveOrderPrice,
  cancelOrder,
  confirmOrder,
  getOrder,
  type OrderDetail,
} from "../../../../../lib/orders-client";
import { formatCurrency, formatDate, formatDateTime } from "../../../../../lib/format";
import { useAuth } from "../../../../../lib/auth";

const STATUS_BADGE = {
  DRAFT: "neutral",
  PENDING_PRICE_APPROVAL: "warning",
  CONFIRMED: "info",
  PARTIALLY_COLLECTED: "info",
  PAID: "success",
  CANCELLED: "danger",
} as const;

const PRICE_STATUS_BADGE = {
  WITHIN_TOLERANCE: "success",
  PENDING_APPROVAL: "warning",
  APPROVED: "info",
} as const;

export default function OrderDetailPage() {
  const t = useTranslations("orders");
  const tDetail = useTranslations("orders.detail");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const { user } = useAuth();

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCollection, setShowCollection] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const o = await getOrder(orderId);
      setOrder(o);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
      else setError(null);
    } finally {
      setLoading(false);
    }
  }, [orderId, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const isOwner = user?.role === "OWNER";
  const isBranchManager = user?.role === "BRANCH_MANAGER";
  const canConfirm =
    !!order &&
    (order.status === "DRAFT" || order.status === "PENDING_PRICE_APPROVAL") &&
    (isOwner || isBranchManager) &&
    !(order.status === "PENDING_PRICE_APPROVAL" && order.priceOverrideStatus === "PENDING_APPROVAL");
  const canApprovePrice =
    !!order && order.priceOverrideStatus === "PENDING_APPROVAL" && isOwner;
  const canCancel =
    !!order &&
    order.status !== "CANCELLED" &&
    order.status !== "DRAFT" &&
    (isOwner || (isBranchManager && order.status === "CONFIRMED"));
  const canAddCollection =
    !!order &&
    order.status !== "CANCELLED" &&
    order.status !== "PAID" &&
    user?.role &&
    ["OWNER", "BRANCH_MANAGER", "ACCOUNTANT"].includes(user.role);

  async function handleAction(fn: () => Promise<unknown>) {
    setActing(true);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      if (err instanceof ApiClientError) setActionError(err.localizedMessage(locale));
      else setActionError(null);
    } finally {
      setActing(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (error || !order) {
    return (
      <div className="space-y-3">
        <Alert variant="error">{error ?? t("loadFailed")}</Alert>
        <Link href={`/${locale}/orders`}>
          <Button variant="ghost">{t("back")}</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-section">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link
            href={`/${locale}/orders`}
            className="text-sm text-textSecondary hover:underline"
          >
            ← {t("back")}
          </Link>
          <h1 className="text-page-title mt-1">{order.customerName}</h1>
          <p dir="ltr" className="text-sm text-textSecondary">
            {formatDate(order.orderDate, locale)} ·{" "}
            {locale === "ar" ? order.branch.nameAr : order.branch.nameEn}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_BADGE[order.status]}>{t(`status.${order.status}`)}</Badge>
          <Badge variant={PRICE_STATUS_BADGE[order.priceOverrideStatus]}>
            {t(`priceOverride.${order.priceOverrideStatus}`)}
          </Badge>
        </div>
      </div>

      {actionError ? <Alert variant="error">{actionError}</Alert> : null}

      <div className="grid grid-cols-1 gap-section md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{tDetail("summary")}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-textSecondary">{t("columns.product")}</span>
              <span dir="ltr">
                {locale === "ar"
                  ? order.productVariant.sku.colorNameAr
                  : order.productVariant.sku.colorNameEn}{" "}
                · {order.productVariant.sku.code} · {order.productVariant.sizeMetersPerBoard}m
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-textSecondary">{t("columns.boards")}</span>
              <span dir="ltr">{order.boardsQuantity}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-textSecondary">
                {tDetail("deviationPercent")}
              </span>
              <span dir="ltr">
                {formatCurrency(order.salePricePerMeter, locale)} /{" "}
                {formatCurrency(order.productVariant.defaultSalePricePerMeter, locale)}
              </span>
            </div>
            {order.priceApprover ? (
              <div className="flex items-center justify-between">
                <span className="text-textSecondary">{tDetail("approvedBy")}</span>
                <span>{order.priceApprover.name}</span>
              </div>
            ) : null}
            {order.priceApprovedAt ? (
              <div className="flex items-center justify-between">
                <span className="text-textSecondary">{tDetail("approvedAt")}</span>
                <span dir="ltr">{formatDateTime(order.priceApprovedAt, locale)}</span>
              </div>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tDetail("amounts")}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-textSecondary">{t("columns.required")}</span>
              <span dir="ltr" className="font-medium">
                {formatCurrency(order.requiredAmount, locale)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-textSecondary">{t("columns.collected")}</span>
              <span dir="ltr">{formatCurrency(order.collectedAmount, locale)}</span>
            </div>
            <div className="flex items-center justify-between border-t border-border pt-2">
              <span className="text-textSecondary">{t("columns.remaining")}</span>
              <span dir="ltr" className="font-medium">
                {formatCurrency(order.remainingAmount, locale)}
              </span>
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{tDetail("actions")}</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="flex flex-wrap items-center gap-2">
            {canApprovePrice ? (
              <Button
                variant="primary"
                disabled={acting}
                onClick={() => void handleAction(() => approveOrderPrice(order.id))}
              >
                {tDetail("approvePrice")}
              </Button>
            ) : null}
            {canConfirm ? (
              <Button
                variant="primary"
                disabled={acting}
                onClick={() => void handleAction(() => confirmOrder(order.id))}
              >
                {tDetail("confirm")}
              </Button>
            ) : null}
            {canAddCollection ? (
              <Button variant="secondary" onClick={() => setShowCollection(true)}>
                {tDetail("addCollection")}
              </Button>
            ) : null}
            {canCancel ? (
              <Button variant="danger" onClick={() => setShowCancel(true)}>
                {tDetail("cancel")}
              </Button>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tDetail("collections")}</CardTitle>
        </CardHeader>
        <CardBody>
          {order.collections.length === 0 ? (
            <p className="text-sm text-textSecondary">{tDetail("noCollections")}</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH dir="ltr">{tDetail("collections")}</TH>
                  <TH dir="ltr" className="text-end">
                    {t("collection.amount")}
                  </TH>
                  <TH>{t("collection.paidToAccount")}</TH>
                </TR>
              </THead>
              <TBody>
                {order.collections.map((c) => {
                  const isRefund = c.amount.startsWith("-");
                  return (
                    <TR key={c.id}>
                      <TD dir="ltr">{formatDateTime(c.collectedAt, locale)}</TD>
                      <TD
                        dir="ltr"
                        className={`text-end font-medium ${
                          isRefund ? "text-danger" : "text-success"
                        }`}
                      >
                        {formatCurrency(c.amount, locale)}
                      </TD>
                      <TD>{c.paidToAccount ?? "—"}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <AuditTail entityType="customer_order" entityId={order.id} />

      <CollectionDrawer
        orderId={order.id}
        remainingAmount={order.remainingAmount}
        isOpen={showCollection}
        onClose={() => setShowCollection(false)}
        onRecorded={() => {
          setShowCollection(false);
          void load();
        }}
      />

      {showCancel ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowCancel(false)}
        >
          <div
            className="w-full max-w-md rounded-md bg-surface p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-section-title mb-3">{tDetail("cancel")}</h2>
            <Label htmlFor="cancel-reason">{tDetail("cancelReason")}</Label>
            <Input
              id="cancel-reason"
              type="text"
              maxLength={500}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              disabled={acting}
            />
            <div className="mt-4 flex items-center justify-between gap-3">
              <Button variant="ghost" onClick={() => setShowCancel(false)} disabled={acting}>
                {tCommon("cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={acting}
                onClick={() =>
                  void handleAction(async () => {
                    await cancelOrder(order.id, cancelReason.trim() || undefined);
                    setShowCancel(false);
                    setCancelReason("");
                  })
                }
              >
                {tDetail("confirmCancel")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
