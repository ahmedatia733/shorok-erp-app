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
import { confirmErrorMessageAr } from "../../../../../../lib/purchase-confirm-error";
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

  // Confirm-modal account selection (Phase 1 stabilization). Accounts come
  // from posting configuration in Phase 3; for now the user picks them here.
  const [leafAccounts, setLeafAccounts] = useState<AccountRow[]>([]);
  const [apAccountId, setApAccountId] = useState("");
  const [taxAccountId, setTaxAccountId] = useState("");
  const [inventoryAccountId, setInventoryAccountId] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    void getPurchaseInvoice(id)
      .then(setInvoice)
      .catch(() => setError(t("loadFailed")));
  }, [id, t]);

  function openConfirm() {
    setConfirmError(null);
    setConfirmOpen(true);
    void listAccounts().then((all) => {
      // Flatten the tree so nested leaves (e.g. VAT 2300 under 2000) appear.
      const leaf = getLeafAccounts(all);
      setLeafAccounts(leaf);
      const liab = leaf.filter((a) => a.category === "LIABILITY");
      const asset = leaf.filter((a) => a.category === "ASSET");
      setApAccountId(
        autoSelectId(liab, "موردون", "دائنون", "payable", "creditor") ??
          autoSelectId(leaf, "موردون", "دائنون", "payable", "creditor") ??
          "",
      );
      setTaxAccountId(autoSelectId(leaf, "ضريبة", "ضرائب", "vat", "tax") ?? "");
      setInventoryAccountId(
        autoSelectId(asset, "مخزون", "بضاعة", "inventory", "stock") ??
          autoSelectId(leaf, "مخزون", "بضاعة", "inventory", "stock") ??
          "",
      );
    });
  }

  const hasTax = invoice ? parseFloat(invoice.taxAmount) > 0 : false;

  async function handleConfirm() {
    setConfirmError(null);
    if (!apAccountId) { setConfirmError("يجب اختيار حساب الموردين قبل ترحيل الفاتورة."); return; }
    if (!inventoryAccountId) { setConfirmError("يجب اختيار حساب المخزون قبل ترحيل الفاتورة."); return; }
    if (hasTax && !taxAccountId) { setConfirmError("يجب اختيار حساب ضريبة المشتريات لأن الفاتورة تحتوي على ضريبة."); return; }
    setActionLoading(true);
    try {
      const updated = await confirmPurchaseInvoice(id, {
        apAccountId,
        taxAccountId: taxAccountId || undefined,
        inventoryAccountId: inventoryAccountId || undefined,
      });
      setInvoice(updated);
      setConfirmOpen(false);
    } catch (err) {
      setConfirmError(confirmErrorMessageAr(err));
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

      {/* Confirm modal — explicit account selection + clear errors (Phase 1) */}
      {confirmOpen && (
        <Modal open onClose={() => setConfirmOpen(false)} title="ترحيل فاتورة المشتريات">
          <div className="space-y-4 text-sm" dir="rtl">
            {confirmError && <Alert variant="error">{confirmError}</Alert>}

            <p className="text-textSecondary">
              اختر الحسابات المطلوبة ثم اضغط ترحيل. سيتم تحديث المخزون وتسجيل القيد المحاسبي.
            </p>

            <ConfirmAccountSelect
              label="حساب الموردين (دائن)"
              required
              value={apAccountId}
              onChange={setApAccountId}
              options={leafAccounts.filter((a) => a.category === "LIABILITY")}
              fallback={leafAccounts}
            />
            <ConfirmAccountSelect
              label="حساب المخزون (مدين)"
              required
              value={inventoryAccountId}
              onChange={setInventoryAccountId}
              options={leafAccounts.filter((a) => a.category === "ASSET")}
              fallback={leafAccounts}
            />
            <ConfirmAccountSelect
              label={`حساب ضريبة المشتريات${hasTax ? " (مطلوب)" : " (اختياري)"}`}
              required={hasTax}
              value={taxAccountId}
              onChange={setTaxAccountId}
              options={leafAccounts}
            />

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

// Simple account dropdown for the Phase 1 confirm modal. `options` is the
// preferred category-filtered list; `fallback` (optional) widens to all
// leaves so a mis-categorised account is still selectable.
function ConfirmAccountSelect({
  label, required, value, onChange, options, fallback,
}: {
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  options: AccountRow[];
  fallback?: AccountRow[];
}) {
  const list = options.length > 0 ? options : (fallback ?? []);
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
      >
        <option value="">— اختر الحساب —</option>
        {list.map((a) => (
          <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
        ))}
      </select>
    </div>
  );
}
