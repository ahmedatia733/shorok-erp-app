"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../i18n";
import { Alert } from "../../../../components/ui/alert";
import { Button } from "../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui/card";
import { EmptyState } from "../../../../components/ui/empty-state";
import { Skeleton } from "../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { SupplierPicker } from "../../../../components/features/factory-ledger/supplier-picker";
import {
  listFactoryLedger,
  type FactoryEntryRow,
} from "../../../../lib/factory-ledger-client";
import { decimalAdd } from "../../../../lib/decimal-string";
import { formatCurrency, formatDate } from "../../../../lib/format";
import { useHasRole } from "../../../../lib/auth";

export default function FactoryOrdersPage() {
  const t = useTranslations("factory_orders");
  const locale = useLocale() as AppLocale;
  const canCreate = useHasRole("ACCOUNTANT");

  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [rows, setRows] = useState<FactoryEntryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supplierId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setRows(null);
    setError(null);
    void (async () => {
      try {
        const page = await listFactoryLedger({ supplierId, limit: 100 });
        if (!cancelled) setRows(page.data);
      } catch {
        if (!cancelled) setError(t("loadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplierId, t]);

  // The list is newest-first. The current running balance = the runningBalance
  // on the most recent row (which the recompute pass keeps correct).
  const summary = useMemo(() => {
    if (!rows || rows.length === 0) {
      return { totalPurchases: "0", totalPaid: "0", currentBalance: "0" };
    }
    let purchases = "0";
    let paid = "0";
    for (const r of rows) {
      purchases = decimalAdd(purchases, r.totalAmount) ?? purchases;
      paid = decimalAdd(paid, r.paidAmount) ?? paid;
    }
    return {
      totalPurchases: purchases,
      totalPaid: paid,
      currentBalance: rows[0]?.runningBalance ?? "0",
    };
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t("title")}</h1>
        {canCreate ? (
          <Link
            href={`/${locale}/factory-orders/new${supplierId ? `?supplierId=${supplierId}` : ""}`}
          >
            <Button>{t("create")}</Button>
          </Link>
        ) : null}
      </div>

      <Card>
        <CardBody>
          <SupplierPicker
            value={supplierId}
            onChange={setSupplierId}
            includeArchived
          />
        </CardBody>
      </Card>

      {supplierId ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card>
            <CardBody>
              <div className="text-sm text-textSecondary">{t("totalPurchases")}</div>
              <div className="mt-1 text-lg font-bold" dir="ltr">
                {formatCurrency(summary.totalPurchases, locale)}
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <div className="text-sm text-textSecondary">{t("totalPaid")}</div>
              <div className="mt-1 text-lg font-bold" dir="ltr">
                {formatCurrency(summary.totalPaid, locale)}
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <div className="text-sm text-textSecondary">{t("currentBalance")}</div>
              <div className="mt-1 text-lg font-bold text-primary" dir="ltr">
                {formatCurrency(summary.currentBalance, locale)}
              </div>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {error ? <Alert variant="error">{error}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("ledger")}</CardTitle>
        </CardHeader>
        <CardBody>
          {!supplierId ? (
            <EmptyState title={t("pickSupplier")} />
          ) : rows === null ? (
            <div className="space-y-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title={t("empty")} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{t("columns.date")}</TH>
                  <TH>{t("columns.kind")}</TH>
                  <TH>{t("columns.product")}</TH>
                  <TH>{t("columns.boards")}</TH>
                  <TH>{t("columns.total")}</TH>
                  <TH>{t("columns.paid")}</TH>
                  <TH>{t("columns.balance")}</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => {
                  const isPayment = r.productVariantId === null;
                  const productLabel = r.productVariant
                    ? `${locale === "ar" ? r.productVariant.sku.colorNameAr : r.productVariant.sku.colorNameEn} · ${r.productVariant.sku.code} · ${r.productVariant.sizeMetersPerBoard} m`
                    : "—";
                  return (
                    <TR key={r.id}>
                      <TD>{formatDate(r.orderDate, locale)}</TD>
                      <TD>{isPayment ? t("kinds.payment") : t("kinds.purchase")}</TD>
                      <TD>{productLabel}</TD>
                      <TD dir="ltr">{r.boardsQuantity ?? "—"}</TD>
                      <TD dir="ltr">{formatCurrency(r.totalAmount, locale)}</TD>
                      <TD dir="ltr">{formatCurrency(r.paidAmount, locale)}</TD>
                      <TD dir="ltr" className="font-medium">
                        {formatCurrency(r.runningBalance, locale)}
                      </TD>
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
