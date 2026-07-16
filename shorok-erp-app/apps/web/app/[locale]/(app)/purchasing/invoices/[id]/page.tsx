"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useParams } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Modal } from "../../../../../../components/ui/modal";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { useHasRole } from "../../../../../../lib/auth";
import {
  getPurchaseInvoice,
  confirmPurchaseInvoice,
  deletePurchaseInvoice,
  type PurchaseInvoiceRow,
} from "../../../../../../lib/purchase-invoices-client";
import { listAccounts, getLeafAccounts, type AccountRow } from "../../../../../../lib/accounts-client";
import { downloadInvoicePdf } from "../../../../../../lib/invoice-pdf-client";
import { ApiClientError } from "../../../../../../lib/api-client";
import { confirmErrorMessageAr } from "../../../../../../lib/purchase-confirm-error";
import { isPostingConfigError } from "../../../../../../lib/posting-config";
import { formatDate, formatCurrency } from "../../../../../../lib/format";

function autoSelectId(accounts: Awaited<ReturnType<typeof listAccounts>>, ...kws: string[]) {
  const lower = kws.map((k) => k.toLowerCase());
  return accounts.find((a) =>
    a.isLeaf && a.active && lower.some((k) => a.nameAr.toLowerCase().includes(k) || (a.nameEn ?? "").toLowerCase().includes(k)),
  )?.id;
}

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

  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmConfigError, setConfirmConfigError] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);

  async function handleExportPdf() {
    if (!invoice || pdfLoading) return;
    setPdfLoading(true);
    setError(null);
    try {
      await downloadInvoicePdf("purchase", invoice.id, invoice.invoiceNumber);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("loadFailed"));
    } finally {
      setPdfLoading(false);
    }
  }

  useEffect(() => {
    void getPurchaseInvoice(id)
      .then(setInvoice)
      .catch(() => setError(t("loadFailed")));
  }, [id, t]);

  function openConfirm() {
    setConfirmError(null);
    setConfirmConfigError(false);
    setConfirmOpen(true);
  }

  async function handleConfirm() {
    setConfirmError(null);
    setConfirmConfigError(false);
    setActionLoading(true);
    try {
      // AP / inventory / VAT-input accounts resolve server-side from the
      // PostingProfile — the client sends no account IDs.
      const updated = await confirmPurchaseInvoice(id, {});
      setInvoice(updated);
      setConfirmOpen(false);
    } catch (err) {
      if (isPostingConfigError(err)) setConfirmConfigError(true);
      else setConfirmError(confirmErrorMessageAr(err));
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
        <Button variant="ghost" size="sm" className="ms-auto" onClick={() => void handleExportPdf()} disabled={pdfLoading}>
          {pdfLoading ? "جارِ التصدير..." : "تصدير PDF"}
        </Button>
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
          <Button onClick={openConfirm}>{t("confirm")}</Button>

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

      {/* Confirm modal — no account selection; accounts resolve server-side. */}
      {confirmOpen && invoice && (
        <Modal open onClose={() => setConfirmOpen(false)} title="تأكيد فاتورة المشتريات">
          <div className="space-y-4 text-sm" dir="rtl">
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 space-y-1">
              <div className="font-bold text-blue-800">{invoice.supplierNameAr}</div>
              <div className="text-xs text-blue-600">فاتورة مشتريات #{invoice.invoiceNumber}</div>
              <div className="flex justify-between font-bold text-blue-800 border-t border-blue-200 pt-1 mt-1">
                <span>الإجمالي</span><span dir="ltr">{formatCurrency(invoice.grandTotal, locale)}</span>
              </div>
            </div>

            <p className="text-xs text-blue-700 bg-blue-50 rounded p-2">
              سيتم تحديث المخزون وتسجيل القيد المحاسبي تلقائيًا وفقًا لإعدادات الحسابات.
            </p>

            {confirmConfigError && (
              <Alert variant="error">
                لا يمكن ترحيل الفاتورة لأن إعدادات حسابات المشتريات غير مكتملة.{" "}
                <a href={`/${locale}/accounting/accounts`} className="underline font-medium">فتح إعدادات الحسابات ↗</a>
              </Alert>
            )}
            {confirmError && <Alert variant="error">{confirmError}</Alert>}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={actionLoading}>
                {tCommon("no")}
              </Button>
              <Button onClick={() => void handleConfirm()} disabled={actionLoading}>
                {actionLoading ? tCommon("loading") : t("confirm")}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

