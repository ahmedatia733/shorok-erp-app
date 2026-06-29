"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useParams } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { useHasRole } from "../../../../../../lib/auth";
import {
  getPurchaseInvoice,
  confirmPurchaseInvoice,
  deletePurchaseInvoice,
  type PurchaseInvoiceRow,
} from "../../../../../../lib/purchase-invoices-client";
import { formatDate, formatCurrency } from "../../../../../../lib/format";

function StatusBadge({ status, t }: { status: string; t: ReturnType<typeof useTranslations> }) {
  const classes: Record<string, string> = {
    DRAFT: "bg-yellow-100 text-yellow-800",
    CONFIRMED: "bg-green-100 text-green-800",
    CANCELLED: "bg-gray-100 text-gray-600",
  };
  const labels: Record<string, string> = {
    DRAFT: t("statusDraft"),
    CONFIRMED: t("statusConfirmed"),
    CANCELLED: t("statusCancelled"),
  };
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${classes[status] ?? ""}`}>
      {labels[status] ?? status}
    </span>
  );
}

export default function PurchaseInvoiceDetailPage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("purchaseInvoices");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const isOwner = useHasRole();

  const [invoice, setInvoice] = useState<PurchaseInvoiceRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    void getPurchaseInvoice(id)
      .then(setInvoice)
      .catch(() => setError(t("loadFailed")));
  }, [id, t]);

  async function handleConfirm() {
    setActionLoading(true);
    try {
      const updated = await confirmPurchaseInvoice(id);
      setInvoice(updated);
      setConfirmOpen(false);
    } catch {
      setError(t("confirmFailed"));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDelete() {
    setActionLoading(true);
    try {
      await deletePurchaseInvoice(id);
      router.push(`/${locale}/purchasing/invoices`);
    } catch {
      setError(tCommon("actionFailed"));
    } finally {
      setActionLoading(false);
    }
  }

  if (!invoice) {
    return (
      <div className="text-textSecondary">
        {error ?? tCommon("loading")}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push(`/${locale}/purchasing/invoices`)}>
          {tCommon("back")}
        </Button>
        <h1 className="text-xl font-bold">{invoice.invoiceNumber}</h1>
        <StatusBadge status={invoice.status} t={t} />
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {/* Header info */}
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-textSecondary">{t("invoiceNumber")}</dt>
              <dd className="font-mono font-medium">{invoice.invoiceNumber}</dd>
            </div>
            <div>
              <dt className="text-textSecondary">{t("invoiceDate")}</dt>
              <dd>{formatDate(invoice.invoiceDate, locale)}</dd>
            </div>
            <div>
              <dt className="text-textSecondary">{t("supplier")}</dt>
              <dd>{locale === "ar" ? invoice.supplierNameAr : invoice.supplierNameEn}</dd>
            </div>
            <div>
              <dt className="text-textSecondary">{t("branch")}</dt>
              <dd>{locale === "ar" ? invoice.branchNameAr : invoice.branchNameEn}</dd>
            </div>
            {invoice.notes && (
              <div className="col-span-2">
                <dt className="text-textSecondary">{t("notes")}</dt>
                <dd>{invoice.notes}</dd>
              </div>
            )}
          </dl>
        </CardBody>
      </Card>

      {/* Lines */}
      <Card>
        <CardHeader>
          <CardTitle>{t("lines")}</CardTitle>
        </CardHeader>
        <CardBody className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>{t("lineCode")}</TH>
                <TH>{t("lineProduct")}</TH>
                <TH>{t("lineUnit")}</TH>
                <TH>{t("lineBoards")}</TH>
                <TH>{t("lineMeters")}</TH>
                <TH>{t("lineUnitPrice")}</TH>
                <TH>{t("lineTotal")}</TH>
                <TH>{t("lineFree")}</TH>
                <TH>{t("lineTaxRate")}</TH>
                <TH>{t("lineTaxAmount")}</TH>
              </TR>
            </THead>
            <TBody>
              {invoice.lines.map((line) => (
                <TR key={line.id}>
                  <TD className="font-mono text-xs">{line.skuCode}</TD>
                  <TD>{locale === "ar" ? line.skuNameAr : line.skuNameEn}</TD>
                  <TD>{line.sizeMetersPerBoard}</TD>
                  <TD>{line.boardsQuantity}</TD>
                  <TD>{line.metersQuantity}</TD>
                  <TD>{formatCurrency(line.unitPrice, locale)}</TD>
                  <TD>{formatCurrency(line.lineTotal, locale)}</TD>
                  <TD>{line.isFree ? "✓" : "—"}</TD>
                  <TD>{line.taxRate}%</TD>
                  <TD>{formatCurrency(line.taxAmount, locale)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      {/* Totals */}
      <Card>
        <CardBody>
          <dl className="space-y-2 text-sm text-end">
            <div className="flex justify-end gap-6">
              <dt className="text-textSecondary">{t("subtotal")}</dt>
              <dd className="w-28">{formatCurrency(invoice.subtotal, locale)}</dd>
            </div>
            <div className="flex justify-end gap-6">
              <dt className="text-textSecondary">{t("taxAmount")}</dt>
              <dd className="w-28">{formatCurrency(invoice.taxAmount, locale)}</dd>
            </div>
            <div className="flex justify-end gap-6 font-bold text-base">
              <dt>{t("grandTotal")}</dt>
              <dd className="w-28">{formatCurrency(invoice.grandTotal, locale)}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      {/* Actions */}
      {isOwner && invoice.status === "DRAFT" && (
        <div className="flex gap-3">
          {confirmOpen ? (
            <div className="flex items-center gap-2">
              <span className="text-sm">{t("confirmPrompt")}</span>
              <Button
                onClick={() => void handleConfirm()}
                disabled={actionLoading}
              >
                {actionLoading ? tCommon("loading") : tCommon("yes")}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                {tCommon("no")}
              </Button>
            </div>
          ) : (
            <Button onClick={() => setConfirmOpen(true)}>{t("confirm")}</Button>
          )}

          {deleteOpen ? (
            <div className="flex items-center gap-2">
              <span className="text-sm">{t("deletePrompt")}</span>
              <Button
                variant="danger"
                onClick={() => void handleDelete()}
                disabled={actionLoading}
              >
                {actionLoading ? tCommon("loading") : tCommon("yes")}
              </Button>
              <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
                {tCommon("no")}
              </Button>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>
              {t("delete")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
