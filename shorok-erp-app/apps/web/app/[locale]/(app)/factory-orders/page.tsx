"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../i18n";
import { Alert } from "../../../../components/ui/alert";
import { Button } from "../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui/card";
import { EmptyState } from "../../../../components/ui/empty-state";
import { Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";
import { Modal } from "../../../../components/ui/modal";
import { Skeleton } from "../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { SupplierPicker } from "../../../../components/features/factory-ledger/supplier-picker";
import {
  listFactoryLedger,
  updateFactoryEntry,
  deleteFactoryEntry,
  type FactoryEntryRow,
} from "../../../../lib/factory-ledger-client";
import { decimalAdd } from "../../../../lib/decimal-string";
import { formatCurrency, formatDate } from "../../../../lib/format";
import { useCurrentUser, useHasRole } from "../../../../lib/auth";
import { ApiClientError } from "../../../../lib/api-client";

export default function FactoryOrdersPage() {
  const t = useTranslations("factory_orders");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const canCreate = useHasRole("ACCOUNTANT");
  const user = useCurrentUser();
  const isOwner = user?.role === "OWNER";

  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [rows, setRows] = useState<FactoryEntryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listSearch, setListSearch] = useState("");

  // delete state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // edit state
  const [editRow, setEditRow] = useState<FactoryEntryRow | null>(null);
  const [editFields, setEditFields] = useState({
    orderDate: "",
    boardsQuantity: "",
    purchasePricePerMeter: "",
    paidAmount: "",
    notes: "",
  });
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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
    return () => { cancelled = true; };
  }, [supplierId, t]);

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

  const handleDelete = async () => {
    if (!deletingId) return;
    setDeleteLoading(true);
    try {
      await deleteFactoryEntry(deletingId);
      setRows((prev) => prev ? prev.filter((r) => r.id !== deletingId) : prev);
      setDeletingId(null);
    } catch {
      setError(tCommon("actionFailed"));
    } finally {
      setDeleteLoading(false);
    }
  };

  const openEdit = (row: FactoryEntryRow) => {
    setEditRow(row);
    setEditFields({
      orderDate: row.orderDate.split("T")[0] ?? "",
      boardsQuantity: row.boardsQuantity ?? "",
      purchasePricePerMeter: row.purchasePricePerMeter ?? "",
      paidAmount: row.paidAmount,
      notes: row.notes ?? "",
    });
    setEditError(null);
  };

  const handleEditSave = async () => {
    if (!editRow) return;
    setEditLoading(true);
    setEditError(null);
    try {
      const updated = await updateFactoryEntry(editRow.id, {
        orderDate: editFields.orderDate,
        boardsQuantity: editFields.boardsQuantity || undefined,
        purchasePricePerMeter: editFields.purchasePricePerMeter || undefined,
        paidAmount: editFields.paidAmount,
        notes: editFields.notes || null,
      });
      setRows((prev) => prev ? prev.map((r) => (r.id === updated.id ? updated : r)) : prev);
      setEditRow(null);
    } catch (err) {
      setEditError(
        err instanceof ApiClientError ? err.localizedMessage(locale) : tCommon("actionFailed"),
      );
    } finally {
      setEditLoading(false);
    }
  };

  const displayedRows = listSearch
    ? (rows ?? []).filter((r) => (r.notes ?? "").toLowerCase().includes(listSearch.toLowerCase()))
    : (rows ?? []);

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
          <SupplierPicker value={supplierId} onChange={setSupplierId} includeArchived />
        </CardBody>
      </Card>

      {supplierId ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card>
            <CardBody>
              <div className="text-sm text-textSecondary">{t("totalPurchases")}</div>
              <div className="mt-1 text-lg font-bold" dir="ltr">{formatCurrency(summary.totalPurchases, locale)}</div>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <div className="text-sm text-textSecondary">{t("totalPaid")}</div>
              <div className="mt-1 text-lg font-bold" dir="ltr">{formatCurrency(summary.totalPaid, locale)}</div>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <div className="text-sm text-textSecondary">{t("currentBalance")}</div>
              <div className="mt-1 text-lg font-bold text-primary" dir="ltr">{formatCurrency(summary.currentBalance, locale)}</div>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {error ? <Alert variant="error">{error}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("ledger")}</CardTitle>
          <div className="flex items-center gap-2">
            <Input placeholder="بحث..." value={listSearch} onChange={(e) => setListSearch(e.target.value)} className="max-w-xs" />
            {listSearch && <button type="button" className="text-xs text-textSecondary hover:text-text" onClick={() => setListSearch("")}>مسح ✕</button>}
          </div>
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
          ) : displayedRows.length === 0 ? (
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
                  {isOwner ? <TH className="w-20"></TH> : null}
                </TR>
              </THead>
              <TBody>
                {displayedRows.map((r) => {
                  const isPayment = r.productVariantId === null;
                  const productLabel = r.productVariant
                    ? `${locale === "ar" ? r.productVariant.sku.colorNameAr : r.productVariant.sku.colorNameEn} · ${r.productVariant.sku.code} · ${r.productVariant.sizeMetersPerBoard} m`
                    : "—";
                  const isDeleting = deletingId === r.id;
                  return (
                    <TR key={r.id}>
                      <TD>{formatDate(r.orderDate, locale)}</TD>
                      <TD>{isPayment ? t("kinds.payment") : t("kinds.purchase")}</TD>
                      <TD>{productLabel}</TD>
                      <TD dir="ltr">{r.boardsQuantity ?? "—"}</TD>
                      <TD dir="ltr">{formatCurrency(r.totalAmount, locale)}</TD>
                      <TD dir="ltr">{formatCurrency(r.paidAmount, locale)}</TD>
                      <TD dir="ltr" className="font-medium">{formatCurrency(r.runningBalance, locale)}</TD>
                      {isOwner ? (
                        <TD>
                          {isDeleting ? (
                            <span className="flex items-center gap-1 text-xs">
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
                            <span className="flex items-center gap-2">
                              {!isPayment && (
                                <button
                                  title={tCommon("edit")}
                                  onClick={() => openEdit(r)}
                                  className="text-base"
                                >
                                  ✏️
                                </button>
                              )}
                              <button
                                title={tCommon("delete")}
                                onClick={() => setDeletingId(r.id)}
                                className="text-base"
                              >
                                🗑️
                              </button>
                            </span>
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

      {/* Edit Modal */}
      <Modal open={!!editRow} onClose={() => setEditRow(null)} title={tCommon("edit")}>
        {editRow && (
          <div className="space-y-3">
            {editError && <Alert variant="error">{editError}</Alert>}
            <div>
              <Label htmlFor="fl-date">{t("form.orderDate")}</Label>
              <Input
                id="fl-date"
                type="date"
                dir="ltr"
                value={editFields.orderDate}
                onChange={(e) => setEditFields((f) => ({ ...f, orderDate: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="fl-boards">{t("form.boardsQuantity")}</Label>
              <Input
                id="fl-boards"
                type="number"
                dir="ltr"
                value={editFields.boardsQuantity}
                onChange={(e) => setEditFields((f) => ({ ...f, boardsQuantity: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="fl-price">{t("form.purchasePricePerMeter")}</Label>
              <Input
                id="fl-price"
                type="number"
                dir="ltr"
                value={editFields.purchasePricePerMeter}
                onChange={(e) => setEditFields((f) => ({ ...f, purchasePricePerMeter: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="fl-paid">{t("form.paidAmountPurchase")}</Label>
              <Input
                id="fl-paid"
                type="number"
                dir="ltr"
                value={editFields.paidAmount}
                onChange={(e) => setEditFields((f) => ({ ...f, paidAmount: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="fl-notes">{t("form.notes")}</Label>
              <Input
                id="fl-notes"
                value={editFields.notes}
                onChange={(e) => setEditFields((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditRow(null)} disabled={editLoading}>
                {tCommon("cancel")}
              </Button>
              <Button onClick={() => void handleEditSave()} disabled={editLoading}>
                {editLoading ? tCommon("loading") : tCommon("save")}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
