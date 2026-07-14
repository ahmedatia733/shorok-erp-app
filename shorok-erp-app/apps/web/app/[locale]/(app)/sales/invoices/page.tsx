"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Modal } from "../../../../../components/ui/modal";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { useHasRole } from "../../../../../lib/auth";
import { resolveVariantCost, COST_MISSING_LABEL, COST_ESTIMATE_LABEL, type CostSource } from "../../../../../lib/variant-cost";
import { isPostingConfigError } from "../../../../../lib/posting-config";
import {
  listSalesInvoices,
  getSalesInvoice,
  createSalesInvoice,
  updateSalesInvoice,
  confirmSalesInvoice,
  cancelSalesInvoice,
  deleteSalesInvoice,
  type SalesInvoiceRow,
  type SalesInvoiceDetail,
} from "../../../../../lib/sales-invoices-client";
import { listCustomers, createCustomer, type CustomerRow } from "../../../../../lib/customers-client";
import { listAccounts, type AccountRow } from "../../../../../lib/accounts-client";
import { apiCall, ApiClientError } from "../../../../../lib/api-client";
import { formatDate, formatCurrency } from "../../../../../lib/format";
import { AP_COLORS, apColorMap } from "../../../../../lib/ap-colors";

// ─── types ───────────────────────────────────────────────────────────────────

const SIZE_K = 5.25;
const SIZE_S = 4.0;

interface BranchOption {
  id: string;
  nameAr: string;
}

interface VariantOption {
  id: string;
  skuCode: string;
  skuNameAr: string;
  sizeMetersPerBoard: string;
  defaultSalePrice: string;
  /** Resolved informational cost (avg_cost → default → null); see resolveVariantCost. */
  costValue: string | null;
  costSource: CostSource;
}

interface LineFormState {
  _key: string;
  colorCode: string;
  productVariantId: string;
  boardsQuantity: string;
  sizeChoice: "" | "K" | "S";
  customL: string;
  customW: string;
  unitLabel: string;
  unitPrice: string;
  costPrice: string;
  taxRate: string;
  // computed
  sqm: string;
  metersQuantity: string;
  lineTotal: string;
  taxAmount: string;
  lineCost: string;
}

function mkLine(): LineFormState {
  return {
    _key: Math.random().toString(36).slice(2),
    colorCode: "",
    productVariantId: "",
    boardsQuantity: "",
    sizeChoice: "",
    customL: "",
    customW: "",
    unitLabel: "متر",
    unitPrice: "0",
    costPrice: "0",
    taxRate: "14",
    sqm: "",
    metersQuantity: "",
    lineTotal: "",
    taxAmount: "",
    lineCost: "",
  };
}

function recomputeLine(line: LineFormState, variant?: VariantOption): Partial<LineFormState> {
  const boards = parseFloat(line.boardsQuantity) || 0;
  const L = parseFloat(line.customL) || 0;
  const W = parseFloat(line.customW) || 0;

  // م² = حجم اللوح الواحد فقط (not multiplied by count)
  const singleBoardSqm =
    L > 0 && W > 0 ? L * W :
    line.sizeChoice === "K" ? SIZE_K :
    line.sizeChoice === "S" ? SIZE_S :
    (variant ? parseFloat(variant.sizeMetersPerBoard) : 0);

  // الكمية (م) = مجموع الأمتار — معلومة فقط، لا تؤثر على الإجمالي
  const totalMeters = singleBoardSqm > 0 ? boards * singleBoardSqm : 0;

  // الإجمالي = العدد × سعر الوحدة (العدد فقط هو الذي يؤثر)
  const price     = parseFloat(line.unitPrice) || 0;
  const cost      = parseFloat(line.costPrice) || 0;
  const lineTotal = boards * price;
  const lineCost  = boards * cost;
  const taxRate   = parseFloat(line.taxRate) || 0;
  const taxAmount = lineTotal * taxRate / 100;

  return {
    sqm:            singleBoardSqm > 0 ? singleBoardSqm.toFixed(4) : "",
    metersQuantity: totalMeters > 0    ? totalMeters.toFixed(4)     : "",
    lineTotal:      lineTotal > 0      ? lineTotal.toFixed(2)        : "",
    lineCost:       lineCost > 0       ? lineCost.toFixed(2)         : "",
    taxAmount:      taxAmount > 0      ? taxAmount.toFixed(2)        : "",
  };
}

// ─── StatusBadge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    DRAFT: "bg-gray-100 text-gray-700",
    CONFIRMED: "bg-green-100 text-green-800",
    CANCELLED: "bg-red-100 text-red-700",
    PAID: "bg-blue-100 text-blue-800",
  };
  const labels: Record<string, string> = {
    DRAFT: "مسودة",
    CONFIRMED: "مؤكدة",
    CANCELLED: "ملغاة",
    PAID: "مدفوعة",
  };
  return (
    <span className={"inline-flex rounded px-2 py-0.5 text-xs font-medium " + (classes[status] ?? "")}>
      {labels[status] ?? status}
    </span>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ─── ConfirmModal ─────────────────────────────────────────────────────────────

interface ConfirmModalProps {
  invoice: SalesInvoiceRow;
  onClose: () => void;
  onConfirmed: (updated: SalesInvoiceDetail) => void;
  locale: AppLocale;
}

function ConfirmModal({ invoice, onClose, onConfirmed, locale }: ConfirmModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configError, setConfigError] = useState(false);

  const grandTotal = parseFloat(invoice.grandTotal);
  const subtotal   = parseFloat(invoice.subtotal);
  const taxAmount  = parseFloat(invoice.taxAmount);
  const totalCost  = parseFloat(invoice.totalCost);
  const hasTax = taxAmount > 0;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    setConfigError(false);
    try {
      // Accounts (AR / revenue / VAT / COGS / inventory) resolve server-side
      // from the PostingProfile — the client sends no account IDs. COGS posts
      // automatically for tracked inventory.
      const result = await confirmSalesInvoice(invoice.id, {});
      onConfirmed(result);
    } catch (e) {
      if (isPostingConfigError(e)) setConfigError(true);
      else setError("فشل تأكيد الفاتورة. يرجى التحقق من البيانات والمحاولة مجدداً.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={true} onClose={onClose} title={`تأكيد الفاتورة — SI-${invoice.invoiceNumber}`} className="max-w-md w-full">
      <div className="space-y-4" dir="rtl">
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
          <div className="text-xs text-blue-500 font-medium">العميل</div>
          <div className="font-bold text-blue-800">{invoice.customer?.code} — {invoice.customer?.nameAr}</div>
        </div>

        <div className="rounded-lg border border-border bg-surface p-3 space-y-1 text-sm">
          <div className="flex justify-between text-textSecondary"><span>صافي المبيعات</span><span dir="ltr">{formatCurrency(subtotal, locale)}</span></div>
          {hasTax && <div className="flex justify-between text-textSecondary"><span>ضريبة القيمة المضافة</span><span dir="ltr">{formatCurrency(taxAmount, locale)}</span></div>}
          <div className="flex justify-between font-bold text-green-700 border-t pt-1 mt-1"><span>الإجمالي</span><span dir="ltr">{formatCurrency(grandTotal, locale)}</span></div>
          {totalCost > 0 && (
            <div className={"flex justify-between font-semibold " + (subtotal - totalCost >= 0 ? "text-green-600" : "text-red-600")}>
              <span>صافي الربح المقدّر</span><span dir="ltr">{formatCurrency(subtotal - totalCost, locale)}</span>
            </div>
          )}
        </div>

        <p className="text-xs text-blue-700 bg-blue-50 rounded p-2">
          سيتم تسجيل قيد المبيعات والضريبة وتكلفة البضاعة المباعة وتحديث المخزون تلقائيًا.
        </p>

        {configError && (
          <Alert variant="error">
            لا يمكن ترحيل الفاتورة لأن إعدادات حسابات المبيعات غير مكتملة.{" "}
            <a href={`/${locale}/accounting/accounts`} className="underline font-medium">فتح إعدادات الحسابات ↗</a>
          </Alert>
        )}
        {error && <Alert variant="error">{error}</Alert>}

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>إلغاء</Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? "جاري التأكيد..." : "تأكيد الفاتورة"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── InvoiceForm ──────────────────────────────────────────────────────────────

interface InvoiceFormProps {
  editInvoice: SalesInvoiceDetail | null;
  customers: CustomerRow[];
  branches: BranchOption[];
  variants: VariantOption[];
  leafAccounts: AccountRow[];
  onBack: () => void;
  onSaved: (inv: SalesInvoiceDetail) => void;
  onConfirmed: (inv: SalesInvoiceDetail) => void;
  onCustomerCreated: (c: CustomerRow) => void;
  locale: AppLocale;
}

function InvoiceForm({
  editInvoice,
  customers,
  branches,
  variants,
  leafAccounts,
  onBack,
  onSaved,
  onConfirmed,
  onCustomerCreated,
  locale,
}: InvoiceFormProps) {
  const [customerId, setCustomerId] = useState(editInvoice?.customer?.id ?? "");
  const [branchId, setBranchId] = useState(editInvoice?.branch?.id ?? "");

  // ── Inline "new customer" (reuses the canonical POST /customers) ──────────
  const canCreateCustomer = useHasRole("ACCOUNTANT"); // OWNER (bypass) or ACCOUNTANT
  const [showNewCust, setShowNewCust] = useState(false);
  const [ncName, setNcName] = useState("");
  const [ncPhone, setNcPhone] = useState("");
  const [ncSaving, setNcSaving] = useState(false);
  const [ncError, setNcError] = useState<string | null>(null);
  const [custMsg, setCustMsg] = useState<string | null>(null);

  function openNewCust() {
    setNcName(""); setNcPhone(""); setNcError(null); setShowNewCust(true);
  }

  async function submitNewCust() {
    if (ncSaving) return; // prevent double submission
    if (!ncName.trim()) { setNcError("اسم العميل مطلوب"); return; }
    setNcSaving(true); setNcError(null);
    try {
      const created = await createCustomer({ nameAr: ncName.trim(), phone: ncPhone.trim() || undefined });
      onCustomerCreated(created); // add to the shared list (parent state)
      setCustomerId(created.id);  // auto-select — invoice lines/prices are untouched
      setShowNewCust(false);
      setCustMsg(`تم إضافة العميل «${created.nameAr}» برقم ${created.code}`);
    } catch (e) {
      // keep the modal open with its values; show the typed server error
      setNcError(e instanceof ApiClientError ? e.localizedMessage(locale) : "فشل إنشاء العميل");
    } finally {
      setNcSaving(false);
    }
  }
  const [invoiceDate, setInvoiceDate] = useState(
    editInvoice ? new Date(editInvoice.invoiceDate).toISOString().slice(0, 10) : todayStr(),
  );
  const [dueDate, setDueDate] = useState(
    editInvoice?.dueDate
      ? new Date(editInvoice.dueDate).toISOString().slice(0, 10)
      : "",
  );
  const [notes, setNotes] = useState(editInvoice?.notes ?? "");
  const [lines, setLines] = useState<LineFormState[]>([mkLine(), mkLine()]);
  const variantMap = new Map(variants.map((v) => [v.id, v]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [savedInvoice, setSavedInvoice] = useState<SalesInvoiceDetail | null>(null);

  function updateLine(idx: number, patch: Partial<LineFormState>) {
    setLines((prev) => {
      const next = [...prev];
      const merged = { ...next[idx]!, ...patch };
      const variant = variantMap.get(merged.productVariantId);
      next[idx] = { ...merged, ...recomputeLine(merged, variant) };
      return next;
    });
  }

  function onVariantChange(idx: number, variantId: string) {
    const variant = variantMap.get(variantId);
    updateLine(idx, {
      productVariantId: variantId,
      unitPrice: variant?.defaultSalePrice ?? "0",
      // Empty (not "0") when no cost is recorded, so the informational cost is
      // never a fabricated zero. COGS is unaffected (server uses avg_cost).
      costPrice: variant?.costValue ?? "",
    });
  }

  // Totals
  const subtotal     = lines.reduce((s, l) => s + (parseFloat(l.lineTotal)  || 0), 0);
  const totalTax     = lines.reduce((s, l) => s + (parseFloat(l.taxAmount)  || 0), 0);
  const totalCost    = lines.reduce((s, l) => s + (parseFloat(l.lineCost)   || 0), 0);
  const grandTotal   = subtotal + totalTax;
  const netProfit    = subtotal - totalCost;   // tax is pass-through; profit = revenue(ex-tax) - cost
  const effectiveTaxRate = subtotal > 0 ? (totalTax / subtotal * 100) : 0;

  async function handleSave(andConfirm = false) {
    setSaving(true);
    setError(null);
    try {
      const validLines = lines.filter(
        (l) => l.productVariantId && parseFloat(l.boardsQuantity) > 0,
      );
      if (!customerId || !branchId) {
        setError("يرجى اختيار العميل والفرع");
        setSaving(false);
        return;
      }
      if (validLines.length === 0) {
        setError("أضف بنداً واحداً على الأقل وأدخل الكمية");
        setSaving(false);
        return;
      }

      const payload = {
        invoiceDate,
        dueDate: dueDate || undefined,
        customerId,
        branchId,
        taxRate: effectiveTaxRate.toFixed(2),
        notes: notes || undefined,
        lines: validLines.map((l) => ({
          productVariantId: l.productVariantId,
          quantity: l.boardsQuantity || "1",
          unitLabel: l.unitLabel || "متر",
          unitPrice: l.unitPrice || "0",
          costPrice: l.costPrice || "0",
          discountPct: "0",
          note: l.colorCode ? `كود: ${l.colorCode}` : undefined,
        })),
      };

      let inv: SalesInvoiceDetail;
      if (editInvoice) {
        inv = await updateSalesInvoice(editInvoice.id, payload);
      } else {
        inv = await createSalesInvoice(payload);
      }
      setSavedInvoice(inv);

      if (andConfirm) {
        setShowConfirmModal(true);
      } else {
        onSaved(inv);
      }
    } catch {
      setError("فشل حفظ الفاتورة. يرجى التحقق من البيانات.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">
          {editInvoice ? `تعديل فاتورة — SI-${editInvoice.invoiceNumber}` : "فاتورة مبيعات جديدة"}
        </h1>
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-blue-600 hover:underline"
        >
          ← رجوع للقائمة
        </button>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {/* Section 1 — Header */}
      <Card>
        <CardHeader>
          <CardTitle>بيانات الفاتورة</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">العميل *</label>
              <div className="flex gap-1">
                <select
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                >
                  <option value="">— اختر العميل —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.code} — {c.nameAr}</option>
                  ))}
                </select>
                {canCreateCustomer && (
                  <button
                    type="button"
                    onClick={openNewCust}
                    title="إضافة عميل جديد"
                    className="shrink-0 rounded border border-primary px-2 py-1.5 text-xs text-primary hover:bg-primary hover:text-white transition-colors"
                  >
                    + عميل جديد
                  </button>
                )}
              </div>
              {custMsg && <p className="mt-1 text-[11px] text-green-600">{custMsg}</p>}
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">الفرع *</label>
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              >
                <option value="">— اختر الفرع —</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.nameAr}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">تاريخ الفاتورة *</label>
              <Input
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">تاريخ الاستحقاق</label>
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">ملاحظات</label>
              <Input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="ملاحظات اختيارية"
              />
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Section 2 — Lines (purchase-invoice style) */}
      <div className="overflow-x-auto border border-border rounded">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-surface text-textSecondary text-xs">
              <th className="border border-border px-2 py-1.5 text-center w-8">#</th>
              <th className="border border-border px-2 py-1.5 text-center w-24">الكود</th>
              <th className="border border-border px-2 py-1.5 text-center min-w-[110px]">اسم الكود</th>
              <th className="border border-border px-2 py-1.5 text-center min-w-[170px]">الصنف</th>
              <th className="border border-border px-2 py-1.5 text-center w-14">عدد</th>
              <th className="border border-border px-2 py-1.5 text-center w-12">كبير</th>
              <th className="border border-border px-2 py-1.5 text-center w-12">صغير</th>
              <th className="border border-border px-2 py-1.5 text-center w-14">طول</th>
              <th className="border border-border px-2 py-1.5 text-center w-14">عرض</th>
              <th className="border border-border px-2 py-1.5 text-center w-14">م²</th>
              <th className="border border-border px-2 py-1.5 text-center w-20">الكمية (م)</th>
              <th className="border border-border px-2 py-1.5 text-center w-20">الوحدة</th>
              <th className="border border-border px-2 py-1.5 text-center w-24">سعر البيع</th>
              <th className="border border-border px-2 py-1.5 text-center w-24">سعر التكلفة</th>
              <th className="border border-border px-2 py-1.5 text-center w-20">الإجمالي</th>
              <th className="border border-border px-2 py-1.5 text-center w-14">ضريبة%</th>
              <th className="border border-border px-2 py-1.5 text-center w-20">قيمة الضريبة</th>
              <th className="border border-border px-2 py-1.5 text-center w-20 text-green-700">ربح السطر</th>
              <th className="border border-border px-2 py-1.5 w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => {
              const selVariant = variantMap.get(line.productVariantId);
              const costMissing = selVariant?.costSource === "missing";
              const costEstimate = selVariant?.costSource === "estimate";
              const lineProfit =
                (parseFloat(line.lineTotal) || 0) - (parseFloat(line.lineCost) || 0);
              const profitPct =
                parseFloat(line.lineTotal) > 0
                  ? (lineProfit / parseFloat(line.lineTotal)) * 100
                  : 0;
              return (
                <tr key={line._key} className="hover:bg-surface/50">
                  <td className="border border-border px-1 py-1 text-center text-textSecondary text-xs">
                    {idx + 1}
                  </td>
                  {/* الكود */}
                  <td className="border border-border px-1 py-1">
                    <select
                      value={line.colorCode}
                      onChange={(e) => updateLine(idx, { colorCode: e.target.value })}
                      className="w-full bg-transparent text-sm focus:outline-none font-mono"
                    >
                      <option value="">—</option>
                      {AP_COLORS.map((c) => (
                        <option key={c.code} value={c.code}>{c.code}</option>
                      ))}
                    </select>
                  </td>
                  {/* اسم الكود */}
                  <td className="border border-border px-1 py-1 text-xs text-end pe-2">
                    {line.colorCode ? (apColorMap.get(line.colorCode)?.nameAr ?? "") : ""}
                  </td>
                  {/* الصنف */}
                  <td className="border border-border px-1 py-1">
                    <select
                      value={line.productVariantId}
                      onChange={(e) => onVariantChange(idx, e.target.value)}
                      className="w-full bg-transparent text-sm focus:outline-none"
                    >
                      <option value="">اختر الصنف</option>
                      {variants.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.skuCode} — {v.skuNameAr} ({v.sizeMetersPerBoard}م) · بيع {v.defaultSalePrice} · تكلفة {v.costSource === "missing" ? "غير مسجل" : `${v.costValue}${v.costSource === "estimate" ? ` (${COST_ESTIMATE_LABEL})` : ""}`}
                        </option>
                      ))}
                    </select>
                  </td>
                  {/* عدد */}
                  <td className="border border-border px-1 py-1">
                    <input
                      type="number" min="0" step="1"
                      value={line.boardsQuantity}
                      onChange={(e) => updateLine(idx, { boardsQuantity: e.target.value })}
                      className="w-full text-center bg-transparent text-sm focus:outline-none"
                      dir="ltr"
                    />
                  </td>
                  {/* ك */}
                  <td className="border border-border px-1 py-1 text-center">
                    <button
                      type="button"
                      onClick={() => updateLine(idx, { sizeChoice: line.sizeChoice === "K" ? "" : "K", customL: "", customW: "" })}
                      className={"w-7 h-7 rounded text-xs font-bold border transition-colors " + (
                        line.sizeChoice === "K"
                          ? "bg-primary text-white border-primary"
                          : "border-border text-textSecondary hover:border-primary"
                      )}
                    >ك</button>
                  </td>
                  {/* ص */}
                  <td className="border border-border px-1 py-1 text-center">
                    <button
                      type="button"
                      onClick={() => updateLine(idx, { sizeChoice: line.sizeChoice === "S" ? "" : "S", customL: "", customW: "" })}
                      className={"w-7 h-7 rounded text-xs font-bold border transition-colors " + (
                        line.sizeChoice === "S"
                          ? "bg-primary text-white border-primary"
                          : "border-border text-textSecondary hover:border-primary"
                      )}
                    >ص</button>
                  </td>
                  {/* طول */}
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" step="0.01" value={line.customL}
                      onChange={(e) => updateLine(idx, { customL: e.target.value, sizeChoice: "" })}
                      className="w-full text-center bg-transparent text-xs focus:outline-none" dir="ltr" />
                  </td>
                  {/* عرض */}
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" step="0.01" value={line.customW}
                      onChange={(e) => updateLine(idx, { customW: e.target.value, sizeChoice: "" })}
                      className="w-full text-center bg-transparent text-xs focus:outline-none" dir="ltr" />
                  </td>
                  {/* م² */}
                  <td className="border border-border px-1 py-1 text-center text-xs text-primary font-semibold" dir="ltr">
                    {line.sqm}
                  </td>
                  {/* الكمية (م) */}
                  <td className="border border-border px-1 py-1 text-center text-xs font-semibold" dir="ltr">
                    {line.metersQuantity}
                  </td>
                  {/* الوحدة */}
                  <td className="border border-border px-1 py-1">
                    <input type="text" value={line.unitLabel}
                      onChange={(e) => updateLine(idx, { unitLabel: e.target.value })}
                      className="w-full text-center bg-transparent text-xs focus:outline-none" />
                  </td>
                  {/* سعر البيع */}
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" step="0.01" value={line.unitPrice}
                      onChange={(e) => updateLine(idx, { unitPrice: e.target.value })}
                      className="w-full text-center bg-transparent text-sm focus:outline-none" dir="ltr" />
                  </td>
                  {/* سعر التكلفة */}
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" step="0.01" value={line.costPrice}
                      onChange={(e) => updateLine(idx, { costPrice: e.target.value })}
                      placeholder={costMissing ? COST_MISSING_LABEL : ""}
                      title={costMissing ? COST_MISSING_LABEL : costEstimate ? `${COST_ESTIMATE_LABEL} — من سعر الشراء الافتراضي` : ""}
                      className={
                        "w-full text-center bg-transparent text-xs focus:outline-none " +
                        (costMissing ? "placeholder:text-red-500 placeholder:text-[10px]" : costEstimate ? "text-amber-600" : "")
                      }
                      dir="ltr" />
                    {costEstimate && <span className="block text-[9px] text-amber-600 text-center leading-none">{COST_ESTIMATE_LABEL}</span>}
                  </td>
                  {/* الإجمالي */}
                  <td className="border border-border px-1 py-1 text-center font-semibold text-xs" dir="ltr">
                    {line.lineTotal}
                  </td>
                  {/* ضريبة% */}
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" max="100" step="0.01" value={line.taxRate}
                      onChange={(e) => updateLine(idx, { taxRate: e.target.value })}
                      className="w-full text-center bg-transparent text-sm focus:outline-none" dir="ltr" />
                  </td>
                  {/* قيمة الضريبة */}
                  <td className="border border-border px-1 py-1 text-center text-xs" dir="ltr">
                    {line.taxAmount}
                  </td>
                  {/* ربح السطر */}
                  <td className={"border border-border px-1 py-1 text-center text-xs font-semibold " + (lineProfit >= 0 ? "text-green-700" : "text-red-600")} dir="ltr">
                    {line.lineTotal ? (
                      <span title={`هامش ${profitPct.toFixed(1)}%`}>
                        {lineProfit.toFixed(2)}
                      </span>
                    ) : ""}
                  </td>
                  {/* ✕ */}
                  <td className="border border-border px-1 py-1 text-center">
                    <button
                      type="button"
                      onClick={() => setLines((p) => p.filter((_, i) => i !== idx))}
                      className="text-textSecondary hover:text-danger text-xs"
                    >✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="border-t border-border p-3 flex items-center justify-between bg-surface">
          <Button variant="ghost" size="sm" onClick={() => setLines((p) => [...p, mkLine()])}>
            + إضافة صنف
          </Button>
          <div className="flex gap-6 text-xs text-textSecondary" dir="ltr">
            <span>المجموع: <strong>{subtotal.toFixed(2)}</strong></span>
            <span>الضريبة: <strong>{totalTax.toFixed(2)}</strong></span>
            <span>التكلفة: <strong>{totalCost.toFixed(2)}</strong></span>
            <span className={"font-bold " + (netProfit >= 0 ? "text-green-700" : "text-red-600")}>
              الربح: {netProfit.toFixed(2)}
            </span>
            <span className="font-bold text-base text-foreground">
              الإجمالي: {grandTotal.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Section 3 — Totals */}
      <Card>
        <CardBody>
          <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
            <div className="flex justify-between">
              <span className="text-gray-600">المجموع الفرعي:</span>
              <span>{subtotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">الضريبة ({effectiveTaxRate.toFixed(1)}%):</span>
              <span>{totalTax.toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-bold text-green-700">
              <span>الإجمالي:</span>
              <span>{formatCurrency(grandTotal, locale)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">إجمالي التكلفة:</span>
              <span>{totalCost.toFixed(2)}</span>
            </div>
            <div className={"flex justify-between font-bold " + (netProfit >= 0 ? "text-green-700" : "text-red-600")}>
              <span>صافي الربح المتوقع:</span>
              <span>{formatCurrency(netProfit, locale)}</span>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Actions */}
      <div className="flex gap-3 no-print">
        <Button onClick={() => void handleSave(false)} disabled={saving}>
          {saving ? "جاري الحفظ..." : "حفظ مسودة"}
        </Button>
        <Button onClick={() => void handleSave(true)} disabled={saving}>
          حفظ وتأكيد
        </Button>
        <Button variant="ghost" onClick={onBack} disabled={saving}>
          إلغاء
        </Button>
      </div>

      {/* Confirm modal triggered after save-and-confirm */}
      {showConfirmModal && savedInvoice && (
        <ConfirmModal
          invoice={savedInvoice}
          onClose={() => setShowConfirmModal(false)}
          onConfirmed={(inv) => {
            setShowConfirmModal(false);
            onConfirmed(inv);
          }}
          locale={locale}
        />
      )}

      <Modal open={showNewCust} onClose={() => !ncSaving && setShowNewCust(false)} title="عميل جديد" className="max-w-md w-full">
        <div className="space-y-3">
          {ncError && <Alert variant="error">{ncError}</Alert>}
          <div>
            <label className="block text-xs text-gray-600 mb-1">اسم العميل *</label>
            <Input value={ncName} onChange={(e) => setNcName(e.target.value)} placeholder="اسم العميل بالعربية" autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") submitNewCust(); }} />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">رقم الهاتف (اختياري)</label>
            <Input value={ncPhone} onChange={(e) => setNcPhone(e.target.value)} placeholder="01xxxxxxxxx" dir="ltr"
              onKeyDown={(e) => { if (e.key === "Enter") submitNewCust(); }} />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setShowNewCust(false)} disabled={ncSaving}>إلغاء</Button>
            <Button onClick={submitNewCust} disabled={ncSaving || !ncName.trim()}>
              {ncSaving ? "جارٍ الحفظ…" : "حفظ العميل"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─── ExpandedRow ──────────────────────────────────────────────────────────────

function ExpandedRow({
  invoice,
  locale,
}: {
  invoice: SalesInvoiceDetail;
  locale: AppLocale;
}) {
  const grandTotal = parseFloat(invoice.grandTotal);
  const totalCost = parseFloat(invoice.totalCost);

  return (
    <div className="p-4 bg-gray-50 text-sm space-y-3" dir="rtl">
      {/* Lines sub-table */}
      <div className="overflow-x-auto">
        <Table>
          <THead>
            <TR>
              <TH>المنتج</TH>
              <TH>الكمية</TH>
              <TH>سعر البيع</TH>
              <TH>التكلفة</TH>
              <TH>خصم%</TH>
              <TH>إجمالي</TH>
              <TH>ربح السطر</TH>
            </TR>
          </THead>
          <TBody>
            {invoice.lines.map((l) => {
              const lineProfit = parseFloat(l.lineTotal) - parseFloat(l.lineCost);
              return (
                <TR key={l.id}>
                  <TD>
                    {l.productVariant?.sku?.code} — {l.productVariant?.sku?.colorNameAr}
                  </TD>
                  <TD>{l.quantity} {l.unitLabel}</TD>
                  <TD>{l.unitPrice}</TD>
                  <TD>{l.costPrice}</TD>
                  <TD>{l.discountPct}%</TD>
                  <TD>{l.lineTotal}</TD>
                  <TD>
                    <span className={lineProfit >= 0 ? "text-green-700" : "text-red-600"}>
                      {lineProfit.toFixed(2)}
                    </span>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-3 gap-2 text-xs bg-white rounded p-3">
        <div>المجموع (قبل ض): {invoice.subtotal}</div>
        <div>الضريبة: {invoice.taxAmount}</div>
        <div className="font-bold text-green-700">الإجمالي: {invoice.grandTotal}</div>
        <div>التكلفة: {invoice.totalCost}</div>
        <div className={"font-bold col-span-2 " + (parseFloat(invoice.subtotal) - totalCost >= 0 ? "text-green-700" : "text-red-600")}>
          صافي الربح: {(parseFloat(invoice.subtotal) - totalCost).toFixed(2)}
        </div>
      </div>

      {/* Accounting links */}
      {invoice.status === "CONFIRMED" && (
        <div className="bg-white rounded border border-border p-3 space-y-2">
          <div className="text-xs font-semibold text-textSecondary">كشوف الحسابات المرتبطة</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {invoice.customer && (
              <a
                href={`/${locale}/accounting/customers?customerId=${invoice.customer.id}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                ← عرض كشف العميل
              </a>
            )}
            {invoice.arAccountId && (
              <a
                href={`/${locale}/accounting/statement?accountId=${invoice.arAccountId}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                ← عرض كشف الذمم المدينة
              </a>
            )}
            {invoice.revenueAccountId && (
              <a
                href={`/${locale}/accounting/statement?accountId=${invoice.revenueAccountId}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                ← عرض كشف الإيرادات
              </a>
            )}
            {invoice.taxAccountId && (
              <a
                href={`/${locale}/accounting/tax?accountId=${invoice.taxAccountId}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                ← عرض حساب الضريبة (VAT)
              </a>
            )}
            {invoice.cogsAccountId && (
              <a
                href={`/${locale}/accounting/statement?accountId=${invoice.cogsAccountId}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                ← عرض كشف تكلفة المبيعات
              </a>
            )}
          </div>
          <div className="flex gap-2 flex-wrap pt-1">
            {invoice.journalEntryId && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 text-green-800 px-2 py-0.5 text-xs">
                قيد #{invoice.journalEntryId.slice(0, 8)}
              </span>
            )}
            {invoice.cogsJournalEntryId && (
              <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 text-purple-800 px-2 py-0.5 text-xs">
                قيد COGS #{invoice.cogsJournalEntryId.slice(0, 8)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SalesInvoicesPage() {
  const locale = useLocale() as AppLocale;
  const isOwner = useHasRole();
  const canRecord = useHasRole("ACCOUNTANT");

  // Data
  const [invoices, setInvoices] = useState<SalesInvoiceRow[]>([]);
  const [expandedDetails, setExpandedDetails] = useState<Record<string, SalesInvoiceDetail>>({});
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [variants, setVariants] = useState<VariantOption[]>([]);
  const [leafAccounts, setLeafAccounts] = useState<AccountRow[]>([]);

  // UI state
  const [view, setView] = useState<"list" | "form">("list");
  const [editInvoice, setEditInvoice] = useState<SalesInvoiceDetail | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<SalesInvoiceRow | null>(null);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Filters
  const [filterCustomerId, setFilterCustomerId] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [listSearch, setListSearch] = useState("");

  const displayedInvoices = listSearch
    ? invoices.filter((inv) =>
        (`SI-${inv.invoiceNumber} ${inv.customer?.nameAr ?? ""} ${inv.customer?.code ?? ""}`)
          .toLowerCase()
          .includes(listSearch.toLowerCase()),
      )
    : invoices;

  // Print state
  const [printInvoice, setPrintInvoice] = useState<SalesInvoiceDetail | null>(null);

  const loadInvoices = useCallback(
    async (cursor?: string | null) => {
      try {
        const page = await listSalesInvoices({
          limit: 20,
          cursor,
          customerId: filterCustomerId || undefined,
          status: filterStatus || undefined,
          from: filterFrom || undefined,
          to: filterTo || undefined,
        });
        if (cursor) {
          setInvoices((prev) => [...prev, ...page.data]);
        } else {
          setInvoices(page.data);
        }
        setNextCursor(page.nextCursor);
      } catch {
        setError("فشل تحميل الفواتير");
      }
    },
    [filterCustomerId, filterStatus, filterFrom, filterTo],
  );

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  useEffect(() => {
    void (async () => {
      try {
        const [custs, brs, accts, varRows] = await Promise.all([
          listCustomers(),
          apiCall<BranchOption[]>("/branches"),
          listAccounts(),
          apiCall<Array<{
            id: string;
            sizeMetersPerBoard: string;
            defaultSalePricePerMeter: string;
            defaultPurchasePricePerMeter: string;
            avgCost: string;
            sku: { code: string; colorNameAr: string };
            sizeLabel?: string;
          }>>("/products/variants"),
        ]);
        setCustomers(custs);
        setBranches(brs);
        setLeafAccounts(accts.filter((a) => a.isLeaf && a.active));
        setVariants(
          varRows.map((v) => {
            const cost = resolveVariantCost(v.avgCost, v.defaultPurchasePricePerMeter);
            return {
              id: v.id,
              skuCode: v.sku.code,
              skuNameAr: v.sku.colorNameAr,
              sizeMetersPerBoard: v.sizeMetersPerBoard,
              defaultSalePrice: v.defaultSalePricePerMeter,
              costValue: cost.value,
              costSource: cost.source,
            };
          }),
        );
      } catch {
        // ignore
      }
    })();
  }, []);

  async function toggleExpand(inv: SalesInvoiceRow) {
    if (expandedIds.has(inv.id)) {
      setExpandedIds((prev) => { const s = new Set(prev); s.delete(inv.id); return s; });
      return;
    }
    // Fetch detail if needed
    if (!expandedDetails[inv.id]) {
      try {
        const detail = await getSalesInvoice(inv.id);
        setExpandedDetails((prev) => ({ ...prev, [inv.id]: detail }));
      } catch {
        setError("فشل تحميل تفاصيل الفاتورة");
        return;
      }
    }
    setExpandedIds((prev) => new Set(prev).add(inv.id));
  }

  async function handleCancel(id: string) {
    try {
      await cancelSalesInvoice(id);
      setCancelConfirmId(null);
      await loadInvoices();
    } catch {
      setError("فشل إلغاء الفاتورة");
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteSalesInvoice(id);
      setDeleteConfirmId(null);
      setInvoices((prev) => prev.filter((inv) => inv.id !== id));
    } catch {
      setError("فشل حذف الفاتورة");
    }
  }

  async function handleEdit(inv: SalesInvoiceRow) {
    try {
      const detail = await getSalesInvoice(inv.id);
      setEditInvoice(detail);
      setView("form");
    } catch {
      setError("فشل تحميل بيانات الفاتورة");
    }
  }

  function handleSaved(inv: SalesInvoiceDetail) {
    setView("list");
    setEditInvoice(null);
    void loadInvoices();
  }

  function handleConfirmed(inv: SalesInvoiceDetail) {
    setView("list");
    setEditInvoice(null);
    setConfirmTarget(null);
    void loadInvoices();
  }

  if (view === "form") {
    return (
      <InvoiceForm
        editInvoice={editInvoice}
        customers={customers}
        branches={branches}
        variants={variants}
        leafAccounts={leafAccounts}
        onBack={() => { setView("list"); setEditInvoice(null); }}
        onSaved={handleSaved}
        onConfirmed={handleConfirmed}
        onCustomerCreated={(c) =>
          setCustomers((prev) =>
            prev.some((x) => x.id === c.id)
              ? prev
              : [...prev, c].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
          )
        }
        locale={locale}
      />
    );
  }

  return (
    <div className="space-y-4" dir="rtl">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { font-family: 'Cairo', Arial, sans-serif; }
          .print-only { display: block !important; }
        }
        .print-only { display: none; }
      `}</style>

      <div className="flex items-center justify-between gap-3 no-print">
        <h1 className="text-xl font-bold">فواتير المبيعات</h1>
        {(isOwner || canRecord) && (
          <Button onClick={() => { setEditInvoice(null); setView("form"); }}>
            + فاتورة جديدة
          </Button>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {/* Filters */}
      <Card className="no-print">
        <CardBody>
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs text-gray-600 mb-1">العميل</label>
              <select
                value={filterCustomerId}
                onChange={(e) => setFilterCustomerId(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1.5 text-sm"
              >
                <option value="">— الكل —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} — {c.nameAr}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">الحالة</label>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1.5 text-sm"
              >
                <option value="">— الكل —</option>
                <option value="DRAFT">مسودة</option>
                <option value="CONFIRMED">مؤكدة</option>
                <option value="CANCELLED">ملغاة</option>
                <option value="PAID">مدفوعة</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">من</label>
              <Input
                type="date"
                value={filterFrom}
                onChange={(e) => setFilterFrom(e.target.value)}
                className="w-36"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">إلى</label>
              <Input
                type="date"
                value={filterTo}
                onChange={(e) => setFilterTo(e.target.value)}
                className="w-36"
              />
            </div>
            <Button onClick={() => void loadInvoices()}>بحث</Button>
            <div className="flex items-center gap-1">
              <Input
                placeholder="بحث سريع برقم أو عميل..."
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                className="w-44"
              />
              {listSearch && (
                <button type="button" className="text-xs text-textSecondary hover:text-text" onClick={() => setListSearch("")}>✕</button>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Table */}
      <Card>
        <CardBody className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>#</TH>
                <TH>رقم الفاتورة</TH>
                <TH>التاريخ</TH>
                <TH>الاستحقاق</TH>
                <TH>العميل</TH>
                <TH>الحالة</TH>
                <TH>الإجمالي</TH>
                <TH>الربح</TH>
                <TH className="no-print">إجراءات</TH>
              </TR>
            </THead>
            <TBody>
              {displayedInvoices.length === 0 ? (
                <TR>
                  <TD colSpan={9} className="text-center text-gray-400 py-8">
                    {listSearch ? "لا توجد نتائج مطابقة" : "لا توجد فواتير"}
                  </TD>
                </TR>
              ) : (
                displayedInvoices.map((inv, idx) => {
                  const grandTotal = parseFloat(inv.grandTotal);
                  const totalCost = parseFloat(inv.totalCost);
                  const profit = grandTotal - totalCost;
                  const isExpanded = expandedIds.has(inv.id);

                  return (
                    <>
                      <TR key={inv.id}>
                        <TD>{idx + 1}</TD>
                        <TD className="font-mono">SI-{inv.invoiceNumber}</TD>
                        <TD>{formatDate(inv.invoiceDate, locale)}</TD>
                        <TD>{inv.dueDate ? formatDate(inv.dueDate, locale) : "—"}</TD>
                        <TD>{inv.customer?.code} — {inv.customer?.nameAr}</TD>
                        <TD><StatusBadge status={inv.status} /></TD>
                        <TD className="font-medium text-green-700">{formatCurrency(inv.grandTotal, locale)}</TD>
                        <TD>
                          {totalCost > 0 ? (
                            <span className={profit >= 0 ? "text-green-700" : "text-red-600"}>
                              {formatCurrency(profit, locale)}
                            </span>
                          ) : "—"}
                        </TD>
                        <TD className="no-print">
                          <div className="flex gap-1 flex-wrap text-xs">
                            <button
                              type="button"
                              onClick={() => void toggleExpand(inv)}
                              className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200"
                            >
                              {isExpanded ? "إخفاء" : "تفاصيل"}
                            </button>
                            {inv.status === "DRAFT" && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setConfirmTarget(inv)}
                                  className="px-2 py-1 rounded bg-green-100 hover:bg-green-200 text-green-800"
                                >
                                  تأكيد
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleEdit(inv)}
                                  className="px-2 py-1 rounded bg-blue-100 hover:bg-blue-200 text-blue-800"
                                >
                                  تعديل
                                </button>
                              </>
                            )}
                            {(inv.status === "DRAFT" || inv.status === "CONFIRMED") && isOwner && (
                              <button
                                type="button"
                                onClick={() => setCancelConfirmId(inv.id)}
                                className="px-2 py-1 rounded bg-orange-100 hover:bg-orange-200 text-orange-800"
                              >
                                إلغاء
                              </button>
                            )}
                            {inv.status === "DRAFT" && isOwner && (
                              <button
                                type="button"
                                onClick={() => setDeleteConfirmId(inv.id)}
                                className="px-2 py-1 rounded bg-red-100 hover:bg-red-200 text-red-700"
                              >
                                حذف
                              </button>
                            )}
                          </div>
                        </TD>
                      </TR>

                      {/* Expanded detail row */}
                      {(() => {
                        const detail = isExpanded ? expandedDetails[inv.id] : undefined;
                        if (!detail) return null;
                        return (
                          <TR key={inv.id + "-expanded"}>
                            <TD colSpan={9} className="p-0">
                              <div className="border-t">
                                <ExpandedRow invoice={detail} locale={locale} />
                                <div className="p-3 no-print">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setPrintInvoice(detail);
                                      setTimeout(() => window.print(), 100);
                                    }}
                                    className="text-xs px-3 py-1 rounded border hover:bg-gray-50"
                                  >
                                    طباعة
                                  </button>
                                </div>
                              </div>
                            </TD>
                          </TR>
                        );
                      })()}
                    </>
                  );
                })
              )}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      {/* Load More */}
      {nextCursor && (
        <div className="flex justify-center no-print">
          <Button
            variant="ghost"
            onClick={async () => {
              setLoadingMore(true);
              await loadInvoices(nextCursor);
              setLoadingMore(false);
            }}
            disabled={loadingMore}
          >
            {loadingMore ? "جاري التحميل..." : "تحميل المزيد"}
          </Button>
        </div>
      )}

      {/* Confirm Modal */}
      {confirmTarget && (
        <ConfirmModal
          invoice={confirmTarget}
          onClose={() => setConfirmTarget(null)}
          onConfirmed={(inv) => {
            setConfirmTarget(null);
            void loadInvoices();
          }}
          locale={locale}
        />
      )}

      {/* Cancel confirm inline */}
      {cancelConfirmId && (
        <Modal open={true} onClose={() => setCancelConfirmId(null)} className="max-w-md w-full">
          <div className="p-6 space-y-4" dir="rtl">
            <h3 className="font-bold text-lg">تأكيد الإلغاء</h3>
            <p className="text-sm text-gray-600">
              هل أنت متأكد من إلغاء هذه الفاتورة؟
              {invoices.find((i) => i.id === cancelConfirmId)?.status === "CONFIRMED" &&
                " سيتم إنشاء قيد عكسي في كشف حساب العميل."}
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setCancelConfirmId(null)}>تراجع</Button>
              <Button onClick={() => void handleCancel(cancelConfirmId)}>تأكيد الإلغاء</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete confirm inline */}
      {deleteConfirmId && (
        <Modal open={true} onClose={() => setDeleteConfirmId(null)} className="max-w-md w-full">
          <div className="p-6 space-y-4" dir="rtl">
            <h3 className="font-bold text-lg">تأكيد الحذف</h3>
            <p className="text-sm text-gray-600">هل أنت متأكد من حذف هذه الفاتورة نهائياً؟ لا يمكن التراجع عن هذا الإجراء.</p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setDeleteConfirmId(null)}>تراجع</Button>
              <Button onClick={() => void handleDelete(deleteConfirmId)}>حذف نهائي</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Print Layout */}
      {printInvoice && (
        <div className="print-only fixed inset-0 bg-white p-8 text-sm" dir="rtl">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold">شروق · Shorok — نظام إدارة المؤسسة</h1>
            <h2 className="text-lg mt-2">فاتورة مبيعات رقم: SI-{printInvoice.invoiceNumber}</h2>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
            <div>
              <strong>التاريخ:</strong> {formatDate(printInvoice.invoiceDate, locale)}
            </div>
            <div>
              <strong>الاستحقاق:</strong>{" "}
              {printInvoice.dueDate ? formatDate(printInvoice.dueDate, locale) : "—"}
            </div>
            <div>
              <strong>الحالة:</strong>{" "}
              {{DRAFT:"مسودة",CONFIRMED:"مؤكدة",CANCELLED:"ملغاة",PAID:"مدفوعة"}[printInvoice.status] ?? printInvoice.status}
            </div>
            <div>
              <strong>العميل:</strong> {printInvoice.customer?.code} — {printInvoice.customer?.nameAr}
            </div>
            <div>
              <strong>الفرع:</strong> {printInvoice.branch?.nameAr}
            </div>
          </div>

          <table className="w-full border-collapse border border-gray-300 text-xs mb-4">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-gray-300 px-2 py-1">المنتج</th>
                <th className="border border-gray-300 px-2 py-1">الكمية</th>
                <th className="border border-gray-300 px-2 py-1">الوحدة</th>
                <th className="border border-gray-300 px-2 py-1">السعر</th>
                <th className="border border-gray-300 px-2 py-1">خصم%</th>
                <th className="border border-gray-300 px-2 py-1">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {printInvoice.lines.map((l) => (
                <tr key={l.id}>
                  <td className="border border-gray-300 px-2 py-1">
                    {l.productVariant?.sku?.code} — {l.productVariant?.sku?.colorNameAr}
                  </td>
                  <td className="border border-gray-300 px-2 py-1 text-center">{l.quantity}</td>
                  <td className="border border-gray-300 px-2 py-1 text-center">{l.unitLabel}</td>
                  <td className="border border-gray-300 px-2 py-1 text-left">{l.unitPrice}</td>
                  <td className="border border-gray-300 px-2 py-1 text-center">{l.discountPct}%</td>
                  <td className="border border-gray-300 px-2 py-1 text-left font-medium">{l.lineTotal}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="text-left space-y-1 mb-4">
            <div>المجموع: {printInvoice.subtotal}</div>
            <div>الخصم: {printInvoice.discountAmount}</div>
            <div>الضريبة: {printInvoice.taxAmount}</div>
            <div className="font-bold text-lg">الإجمالي: {formatCurrency(printInvoice.grandTotal, locale)}</div>
          </div>

          {printInvoice.notes && (
            <div className="mb-4">
              <strong>ملاحظات:</strong> {printInvoice.notes}
            </div>
          )}

          <div className="text-center text-xs text-gray-400 mt-8 border-t pt-4">
            تم الإنشاء بواسطة نظام شروق ERP
          </div>
        </div>
      )}
    </div>
  );
}
