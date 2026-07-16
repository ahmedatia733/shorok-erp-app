"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Modal } from "../../../../../../components/ui/modal";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { useHasRole } from "../../../../../../lib/auth";
import {
  getSalesInvoice,
  confirmSalesInvoice,
  cancelSalesInvoice,
  type SalesInvoiceDetail,
} from "../../../../../../lib/sales-invoices-client";
import { listAccounts, type AccountRow } from "../../../../../../lib/accounts-client";
import { downloadInvoicePdf } from "../../../../../../lib/invoice-pdf-client";
import { ApiClientError } from "../../../../../../lib/api-client";
import { formatDate, formatCurrency } from "../../../../../../lib/format";

// ─── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    DRAFT: "bg-gray-100 text-gray-700",
    CONFIRMED: "bg-green-100 text-green-800",
    CANCELLED: "bg-red-100 text-red-700",
    PAID: "bg-blue-100 text-blue-800",
  };
  const labels: Record<string, string> = {
    DRAFT: "مسودة", CONFIRMED: "مؤكدة", CANCELLED: "ملغاة", PAID: "مدفوعة",
  };
  return (
    <span className={"inline-flex rounded px-2 py-0.5 text-xs font-medium " + (cls[status] ?? "")}>
      {labels[status] ?? status}
    </span>
  );
}

// ─── Account auto-select helper ────────────────────────────────────────────────

function autoSelect(accounts: AccountRow[], ...keywords: string[]): string {
  const kws = keywords.map((k) => k.toLowerCase());
  return accounts.find((a) =>
    kws.some((k) => a.nameAr.toLowerCase().includes(k) || (a.nameEn ?? "").toLowerCase().includes(k)),
  )?.id ?? "";
}

// ─── Confirm Modal ─────────────────────────────────────────────────────────────

function ConfirmModal({
  invoice,
  leafAccounts,
  locale,
  onClose,
  onConfirmed,
}: {
  invoice: SalesInvoiceDetail;
  leafAccounts: AccountRow[];
  locale: AppLocale;
  onClose: () => void;
  onConfirmed: (inv: SalesInvoiceDetail) => void;
}) {
  const grandTotal = parseFloat(invoice.grandTotal);
  const subtotal   = parseFloat(invoice.subtotal);
  const taxAmount  = parseFloat(invoice.taxAmount);
  const totalCost  = parseFloat(invoice.totalCost);
  const hasTax = taxAmount > 0;

  const [arAccountId,        setArAccountId]        = useState("");
  const [revenueAccountId,   setRevenueAccountId]   = useState("");
  const [taxAccountId,       setTaxAccountId]       = useState("");
  const [postJournalEntry,   setPostJournalEntry]   = useState(true);
  const [postCogs,           setPostCogs]           = useState(false);
  const [cogsAccountId,      setCogsAccountId]      = useState("");
  const [inventoryAccountId, setInventoryAccountId] = useState("");
  const [submitting,         setSubmitting]         = useState(false);
  const [error,              setError]              = useState<string | null>(null);

  useEffect(() => {
    const assets     = leafAccounts.filter((a) => a.category === "ASSET");
    const revenues   = leafAccounts.filter((a) => a.category === "REVENUE");
    const cogs       = leafAccounts.filter((a) => a.category === "COST_OF_SALES");
    const liabilities = leafAccounts.filter((a) => a.category === "LIABILITY");

    setArAccountId(autoSelect(assets, "ذمم", "مدينين", "receivable", "ar"));
    setRevenueAccountId(autoSelect(revenues, "مبيعات", "إيرادات", "revenue", "sales"));
    setTaxAccountId(
      autoSelect(leafAccounts, "ضريبة", "vat", "tax") ||
      autoSelect(liabilities, "ضريبة", "vat", "tax") ||
      (liabilities[0]?.id ?? ""),
    );
    setCogsAccountId(autoSelect(cogs, "تكلفة", "cogs", "cost"));
    setInventoryAccountId(autoSelect(assets, "مخزون", "بضاعة", "inventory", "stock"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const arAcc   = leafAccounts.find((a) => a.id === arAccountId);
  const revAcc  = leafAccounts.find((a) => a.id === revenueAccountId);
  const taxAcc  = leafAccounts.find((a) => a.id === taxAccountId);
  const cogsAcc = leafAccounts.find((a) => a.id === cogsAccountId);
  const invAcc  = leafAccounts.find((a) => a.id === inventoryAccountId);

  const canSubmit =
    arAccountId && revenueAccountId &&
    (!hasTax || !postJournalEntry || taxAccountId) &&
    (!postCogs || (cogsAccountId && inventoryAccountId));

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await confirmSalesInvoice(invoice.id, {
        arAccountId,
        revenueAccountId,
        taxAccountId: taxAccountId || undefined,
        postJournalEntry,
        postCogs,
        cogsAccountId: cogsAccountId || undefined,
        inventoryAccountId: inventoryAccountId || undefined,
      });
      onConfirmed(result);
    } catch {
      setError("فشل تأكيد الفاتورة. يرجى التحقق من البيانات.");
    } finally {
      setSubmitting(false);
    }
  }

  const allLeaf     = leafAccounts;
  const assetAccs   = leafAccounts.filter((a) => a.category === "ASSET");
  const revenueAccs = leafAccounts.filter((a) => a.category === "REVENUE");
  const cogsAccs    = leafAccounts.filter((a) => a.category === "COST_OF_SALES");
  const taxPrimary  = leafAccounts.filter((a) => /ضريبة|vat|tax/i.test(a.nameAr + (a.nameEn ?? "")));

  function AccountPicker({
    label, value, onChange, options, required,
  }: { label: string; value: string; onChange: (id: string) => void; options: AccountRow[]; required?: boolean }) {
    return (
      <div>
        <label className="block text-sm font-medium mb-1">
          {label}{required && <span className="text-red-500 ms-1">*</span>}
        </label>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-border rounded px-2 py-1.5 text-sm bg-background"
        >
          <option value="">— اختر الحساب —</option>
          {options.map((a) => (
            <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <Modal open={true} onClose={onClose} className="max-w-2xl w-full">
      <div className="p-6 space-y-4 max-h-[90vh] overflow-y-auto" dir="rtl">
        <h2 className="text-lg font-bold">تأكيد الفاتورة — SI-{invoice.invoiceNumber}</h2>

        <div className="rounded border border-border bg-surface p-3 text-sm space-y-1">
          <div className="flex justify-between"><span>المجموع</span><span>{formatCurrency(subtotal, locale)}</span></div>
          {hasTax && <div className="flex justify-between"><span>الضريبة</span><span>{formatCurrency(taxAmount, locale)}</span></div>}
          <div className="flex justify-between font-bold text-green-700 border-t pt-1">
            <span>الإجمالي</span><span>{formatCurrency(grandTotal, locale)}</span>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded border border-border p-3">
          <input type="checkbox" id="postJe" checked={postJournalEntry}
            onChange={(e) => setPostJournalEntry(e.target.checked)} className="w-4 h-4 accent-primary" />
          <label htmlFor="postJe" className="text-sm cursor-pointer">تسجيل قيد محاسبي في دفتر اليومية</label>
        </div>

        <AccountPicker label="حساب الذمم المدينة / العملاء (مدين) *" value={arAccountId}
          onChange={setArAccountId} options={assetAccs.length ? assetAccs : allLeaf} required />

        <AccountPicker label="حساب إيرادات المبيعات (دائن) *" value={revenueAccountId}
          onChange={setRevenueAccountId} options={revenueAccs.length ? revenueAccs : allLeaf} required />

        {hasTax && (
          <AccountPicker
            label={`حساب ضريبة القيمة المضافة (دائن)${postJournalEntry ? " *" : ""}`}
            value={taxAccountId} onChange={setTaxAccountId}
            options={taxPrimary.length ? taxPrimary : allLeaf}
            required={postJournalEntry}
          />
        )}

        {totalCost > 0 && (
          <div className="space-y-3 border-t pt-3">
            <div className="flex items-center gap-3 rounded border border-border p-3">
              <input type="checkbox" id="postCogs" checked={postCogs}
                onChange={(e) => setPostCogs(e.target.checked)} className="w-4 h-4 accent-primary" />
              <label htmlFor="postCogs" className="text-sm cursor-pointer">
                تسجيل تكلفة البضاعة المباعة (COGS) — Dr تكلفة / Cr مخزون — {formatCurrency(totalCost, locale)}
              </label>
            </div>
            {postCogs && (
              <>
                <AccountPicker label="حساب تكلفة المبيعات (مدين)" value={cogsAccountId}
                  onChange={setCogsAccountId} options={cogsAccs.length ? cogsAccs : allLeaf} />
                <AccountPicker label="حساب المخزون (دائن)" value={inventoryAccountId}
                  onChange={setInventoryAccountId} options={assetAccs} />
              </>
            )}
          </div>
        )}

        {/* GL preview */}
        <div className="rounded bg-gray-950 text-gray-100 p-4 text-xs font-mono space-y-1">
          <div className="text-gray-400 font-bold mb-1">◈ معاينة القيد</div>
          <div className="flex justify-between">
            <span className="text-green-400">Dr  {arAcc?.nameAr ?? "—"}</span>
            <span>{formatCurrency(grandTotal, locale)}</span>
          </div>
          <div className="flex justify-between text-gray-400">
            <span>Cr  {revAcc?.nameAr ?? "—"}</span>
            <span>{formatCurrency(subtotal, locale)}</span>
          </div>
          {hasTax && (
            <div className="flex justify-between text-gray-400">
              <span>Cr  {taxAcc?.nameAr ?? "—"}</span>
              <span>{formatCurrency(taxAmount, locale)}</span>
            </div>
          )}
          {postCogs && totalCost > 0 && (
            <>
              <div className="border-t border-gray-700 mt-1 pt-1 text-gray-400">قيد COGS</div>
              <div className="flex justify-between text-green-400">
                <span>Dr  {cogsAcc?.nameAr ?? "—"}</span>
                <span>{formatCurrency(totalCost, locale)}</span>
              </div>
              <div className="flex justify-between text-gray-400">
                <span>Cr  {invAcc?.nameAr ?? "—"}</span>
                <span>{formatCurrency(totalCost, locale)}</span>
              </div>
            </>
          )}
        </div>

        {error && <Alert variant="error">{error}</Alert>}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>إلغاء</Button>
          <Button onClick={() => void handleConfirm()} disabled={!canSubmit || submitting}>
            {submitting ? "جاري التأكيد..." : "تأكيد الفاتورة"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function SalesInvoiceDetailPage() {
  const params     = useParams<{ id: string }>();
  const locale     = useLocale() as AppLocale;
  const router     = useRouter();
  const isOwner    = useHasRole();
  const canRecord  = useHasRole("ACCOUNTANT");

  const [invoice,      setInvoice]      = useState<SalesInvoiceDetail | null>(null);
  const [leafAccounts, setLeafAccounts] = useState<AccountRow[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [showConfirm,  setShowConfirm]  = useState(false);
  const [cancelModal,  setCancelModal]  = useState(false);
  const [cancelling,   setCancelling]   = useState(false);
  const [pdfLoading,   setPdfLoading]   = useState(false);

  async function handleExportPdf() {
    if (!invoice || pdfLoading) return;
    setPdfLoading(true);
    setError(null);
    try {
      await downloadInvoicePdf("sales", invoice.id, `SI-${invoice.invoiceNumber}`);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "فشل تصدير ملف PDF.");
    } finally {
      setPdfLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const [inv, accts] = await Promise.all([
          getSalesInvoice(params.id),
          listAccounts(),
        ]);
        setInvoice(inv);
        setLeafAccounts(accts.filter((a) => a.isLeaf && a.active));
      } catch {
        setError("فشل تحميل الفاتورة");
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id]);

  async function handleCancel() {
    if (!invoice) return;
    setCancelling(true);
    try {
      await cancelSalesInvoice(invoice.id);
      const updated = await getSalesInvoice(invoice.id);
      setInvoice(updated);
      setCancelModal(false);
    } catch {
      setError("فشل إلغاء الفاتورة");
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-40" />
        <Skeleton className="h-60" />
      </div>
    );
  }

  if (error || !invoice) {
    return <Alert variant="error">{error ?? "الفاتورة غير موجودة"}</Alert>;
  }

  const grandTotal = parseFloat(invoice.grandTotal);
  const subtotal   = parseFloat(invoice.subtotal);
  const taxAmount  = parseFloat(invoice.taxAmount);
  const totalCost  = parseFloat(invoice.totalCost);
  const netProfit  = subtotal - totalCost;

  return (
    <div className="max-w-4xl space-y-4" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.push(`/${locale}/sales/invoices`)}
            className="text-sm text-blue-600 hover:underline"
          >
            ← فواتير المبيعات
          </button>
          <h1 className="text-xl font-bold">SI-{invoice.invoiceNumber}</h1>
          <StatusBadge status={invoice.status} />
        </div>
        <div className="flex gap-2">
          {invoice.status === "DRAFT" && (isOwner || canRecord) && (
            <Button onClick={() => setShowConfirm(true)}>تأكيد الفاتورة</Button>
          )}
          {(invoice.status === "DRAFT" || invoice.status === "CONFIRMED") && isOwner && (
            <Button variant="ghost" onClick={() => setCancelModal(true)}>إلغاء</Button>
          )}
          <Button variant="ghost" onClick={() => void handleExportPdf()} disabled={pdfLoading}>
            {pdfLoading ? "جارِ التصدير..." : "تصدير PDF"}
          </Button>
          <Button variant="ghost" onClick={() => window.print()}>طباعة</Button>
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {/* Invoice header info */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>بيانات الفاتورة</CardTitle></CardHeader>
          <CardBody>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-textSecondary">رقم الفاتورة</dt>
                <dd className="font-mono">SI-{invoice.invoiceNumber}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-textSecondary">تاريخ الفاتورة</dt>
                <dd>{formatDate(invoice.invoiceDate, locale)}</dd>
              </div>
              {invoice.dueDate && (
                <div className="flex justify-between">
                  <dt className="text-textSecondary">تاريخ الاستحقاق</dt>
                  <dd>{formatDate(invoice.dueDate, locale)}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-textSecondary">الحالة</dt>
                <dd><StatusBadge status={invoice.status} /></dd>
              </div>
              {invoice.notes && (
                <div className="flex justify-between">
                  <dt className="text-textSecondary">ملاحظات</dt>
                  <dd className="text-end">{invoice.notes}</dd>
                </div>
              )}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>العميل والملخص المالي</CardTitle></CardHeader>
          <CardBody>
            <dl className="space-y-2 text-sm">
              {invoice.customer && (
                <div className="flex justify-between items-center">
                  <dt className="text-textSecondary">العميل</dt>
                  <dd className="flex items-center gap-2">
                    <span>{invoice.customer.code} — {invoice.customer.nameAr}</span>
                    <a
                      href={`/${locale}/accounting/customers?customerId=${invoice.customer.id}`}
                      target="_blank" rel="noreferrer"
                      className="text-xs text-blue-600 hover:underline"
                    >
                      كشف الحساب ↗
                    </a>
                  </dd>
                </div>
              )}
              {invoice.branch && (
                <div className="flex justify-between">
                  <dt className="text-textSecondary">الفرع</dt>
                  <dd>{invoice.branch.nameAr}</dd>
                </div>
              )}
              <div className="border-t pt-2 space-y-1">
                <div className="flex justify-between">
                  <dt className="text-textSecondary">المجموع الفرعي</dt>
                  <dd>{formatCurrency(subtotal, locale)}</dd>
                </div>
                {taxAmount > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-textSecondary">الضريبة</dt>
                    <dd>{formatCurrency(taxAmount, locale)}</dd>
                  </div>
                )}
                <div className="flex justify-between font-bold text-green-700 border-t pt-1">
                  <dt>الإجمالي</dt>
                  <dd>{formatCurrency(grandTotal, locale)}</dd>
                </div>
                {totalCost > 0 && (
                  <div className={"flex justify-between font-semibold " + (netProfit >= 0 ? "text-green-700" : "text-red-600")}>
                    <dt>صافي الربح</dt>
                    <dd>{formatCurrency(netProfit, locale)}</dd>
                  </div>
                )}
              </div>
            </dl>
          </CardBody>
        </Card>
      </div>

      {/* Lines table */}
      <Card>
        <CardHeader><CardTitle>بنود الفاتورة</CardTitle></CardHeader>
        <CardBody className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>#</TH>
                <TH>المنتج</TH>
                <TH>الكمية</TH>
                <TH>الوحدة</TH>
                <TH>سعر البيع</TH>
                <TH>التكلفة</TH>
                <TH>خصم%</TH>
                <TH>الإجمالي</TH>
                <TH>ربح السطر</TH>
              </TR>
            </THead>
            <TBody>
              {invoice.lines.map((l, idx) => {
                const lineProfit = parseFloat(l.lineTotal) - parseFloat(l.lineCost);
                return (
                  <TR key={l.id}>
                    <TD>{idx + 1}</TD>
                    <TD>
                      {l.productVariant?.sku?.code
                        ? `${l.productVariant.sku.code} — ${l.productVariant.sku.colorNameAr}`
                        : "—"}
                    </TD>
                    <TD dir="ltr">{l.quantity}</TD>
                    <TD>{l.unitLabel}</TD>
                    <TD dir="ltr">{l.unitPrice}</TD>
                    <TD dir="ltr">{l.costPrice}</TD>
                    <TD dir="ltr">{l.discountPct}%</TD>
                    <TD dir="ltr" className="font-semibold">{l.lineTotal}</TD>
                    <TD dir="ltr">
                      <span className={lineProfit >= 0 ? "text-green-700" : "text-red-600"}>
                        {lineProfit.toFixed(2)}
                      </span>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      {/* Accounting links — only when confirmed */}
      {invoice.status === "CONFIRMED" && (
        <Card>
          <CardHeader><CardTitle>الحسابات المرتبطة</CardTitle></CardHeader>
          <CardBody>
            <div className="flex flex-wrap gap-3">
              {invoice.arAccountId && (
                <a
                  href={`/${locale}/accounting/statement?accountId=${invoice.arAccountId}`}
                  target="_blank" rel="noreferrer"
                  className="text-xs text-blue-600 hover:underline"
                >
                  ← كشف الذمم المدينة
                </a>
              )}
              {invoice.revenueAccountId && (
                <a
                  href={`/${locale}/accounting/statement?accountId=${invoice.revenueAccountId}`}
                  target="_blank" rel="noreferrer"
                  className="text-xs text-blue-600 hover:underline"
                >
                  ← كشف الإيرادات
                </a>
              )}
              {invoice.taxAccountId && (
                <a
                  href={`/${locale}/accounting/tax?accountId=${invoice.taxAccountId}`}
                  target="_blank" rel="noreferrer"
                  className="text-xs text-blue-600 hover:underline"
                >
                  ← حساب الضريبة (VAT)
                </a>
              )}
              {invoice.cogsAccountId && (
                <a
                  href={`/${locale}/accounting/statement?accountId=${invoice.cogsAccountId}`}
                  target="_blank" rel="noreferrer"
                  className="text-xs text-blue-600 hover:underline"
                >
                  ← كشف تكلفة المبيعات
                </a>
              )}
            </div>
            <div className="flex gap-2 flex-wrap mt-3">
              {invoice.journalEntryId && (
                <span className="inline-flex items-center rounded-full bg-green-100 text-green-800 px-2 py-0.5 text-xs">
                  قيد #{invoice.journalEntryId.slice(0, 8)}
                </span>
              )}
              {invoice.cogsJournalEntryId && (
                <span className="inline-flex items-center rounded-full bg-purple-100 text-purple-800 px-2 py-0.5 text-xs">
                  قيد COGS #{invoice.cogsJournalEntryId.slice(0, 8)}
                </span>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Confirm modal */}
      {showConfirm && (
        <ConfirmModal
          invoice={invoice}
          leafAccounts={leafAccounts}
          locale={locale}
          onClose={() => setShowConfirm(false)}
          onConfirmed={(updated) => {
            setInvoice(updated);
            setShowConfirm(false);
          }}
        />
      )}

      {/* Cancel confirm modal */}
      <Modal open={cancelModal} onClose={() => setCancelModal(false)} className="max-w-md w-full">
        <div className="p-6 space-y-4" dir="rtl">
          <h3 className="font-bold text-lg">تأكيد الإلغاء</h3>
          <p className="text-sm text-gray-600">
            هل أنت متأكد من إلغاء هذه الفاتورة؟
            {invoice.status === "CONFIRMED" &&
              " سيتم إنشاء قيد عكسي في كشف حساب العميل واسترداد المخزون."}
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setCancelModal(false)} disabled={cancelling}>تراجع</Button>
            <Button onClick={() => void handleCancel()} disabled={cancelling}>
              {cancelling ? "جاري الإلغاء..." : "تأكيد الإلغاء"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
