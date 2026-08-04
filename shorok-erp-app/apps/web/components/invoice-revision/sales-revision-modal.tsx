"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Modal } from "../ui/modal";
import { SearchableSelect } from "../ui/searchable-select";
import { ApiClientError } from "../../lib/api-client";
import {
  executeSalesRevision,
  newRevisionIdempotencyKey,
  previewSalesRevision,
  type InvoiceRevisionPreview,
  type SalesRevisionPayload,
} from "../../lib/invoice-revisions-client";
import type { SalesInvoiceDetail } from "../../lib/sales-invoices-client";
import { RevisionComparison } from "./revision-comparison";

/**
 * تعديل الفاتورة المؤكدة — the two-step flow.
 *
 * Step «تحرير» edits the same fields the invoice already stores; step «مراجعة»
 * shows the full comparison the server calculated and refuses to submit until a
 * reason is written and every warning is ticked. The ordinary Save button plays
 * no part here: the only thing that commits is the final button, and it sends
 * the fingerprint from the preview the owner actually read.
 */

interface Option { id: string; label: string }

type LineDraft = {
  lineId?: string;
  productVariantId: string;
  productLabel: string;
  quantity: string;
  unitPrice: string;
  costPrice: string;
  discountPct: string;
  note: string;
};

export function SalesRevisionModal({
  invoice,
  customers,
  branches,
  representatives,
  variants,
  onClose,
  onRevised,
}: {
  invoice: SalesInvoiceDetail & { revisionNumber?: number };
  customers: Option[];
  branches: Option[];
  representatives: Option[];
  variants: Option[];
  onClose: () => void;
  onRevised: (revisionNumber: number) => void;
}) {
  const t = useTranslations("invoiceRevision");
  const currentRevision = invoice.revisionNumber ?? 1;
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<InvoiceRevisionPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [submitKey, setSubmitKey] = useState<string | null>(null);

  const [invoiceDate, setInvoiceDate] = useState(invoice.invoiceDate.slice(0, 10));
  const [dueDate, setDueDate] = useState(invoice.dueDate ? invoice.dueDate.slice(0, 10) : "");
  const [customerId, setCustomerId] = useState(invoice.customer?.id ?? "");
  const [branchId, setBranchId] = useState(invoice.branch?.id ?? "");
  const [repId, setRepId] = useState(invoice.salesRepresentativeId ?? "");
  const [taxRate, setTaxRate] = useState(invoice.taxRate);
  const [notes, setNotes] = useState(invoice.notes ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    invoice.lines.map((l) => ({
      lineId: l.id,
      productVariantId: l.productVariant?.id ?? "",
      productLabel: `${l.productVariant?.sku?.code ?? ""} — ${l.productVariant?.sku?.colorNameAr ?? ""}`,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      costPrice: l.costPrice,
      discountPct: l.discountPct,
      note: l.note ?? "",
    })),
  );

  const payload: SalesRevisionPayload = useMemo(
    () => ({
      invoiceDate,
      dueDate: dueDate || null,
      customerId,
      branchId,
      salesRepresentativeId: repId || null,
      taxRate: taxRate || "0",
      notes: notes || null,
      lines: lines.map((l) => ({
        ...(l.lineId ? { lineId: l.lineId } : {}),
        productVariantId: l.productVariantId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        costPrice: l.costPrice || "0",
        discountPct: l.discountPct || "0",
        ...(l.note ? { note: l.note } : {}),
      })),
    }),
    [invoiceDate, dueDate, customerId, branchId, repId, taxRate, notes, lines],
  );

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const reasonValid = reason.trim().length >= 3;
  const allWarningsAcknowledged =
    preview != null && preview.warnings.every((w) => acknowledged.includes(w.code));
  const canExecute =
    preview != null && preview.blocking.length === 0 && reasonValid && allWarningsAcknowledged && !busy;

  const runPreview = async () => {
    setError(null);
    if (!reasonValid) {
      setError(t("reasonRequired"));
      return;
    }
    if (lines.length === 0) {
      setError("يجب أن تحتوي الفاتورة على بند واحد على الأقل.");
      return;
    }
    setBusy(true);
    try {
      const result = await previewSalesRevision(invoice.id, {
        expectedRevisionNumber: currentRevision,
        reason: reason.trim(),
        payload,
      });
      setPreview(result);
      setAcknowledged([]);
      // A fresh key per approved comparison: a retry of THIS submission is
      // collapsed by the server, while a genuinely new attempt is not.
      setSubmitKey(newRevisionIdempotencyKey(invoice.id));
      setStep("review");
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message_ar : "تعذّر حساب المعاينة.");
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!preview || !submitKey || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await executeSalesRevision(invoice.id, {
        expectedRevisionNumber: currentRevision,
        previewFingerprint: preview.previewFingerprint,
        reason: reason.trim(),
        idempotencyKey: submitKey,
        acknowledgedWarnings: acknowledged,
        payload,
      });
      onRevised(result.revision.revisionNumber);
    } catch (e) {
      // A stale preview is the expected outcome when something moved; send the
      // owner back to a fresh comparison rather than letting them retry blind.
      if (e instanceof ApiClientError) {
        setError(e.payload.message_ar);
        if (String(e.payload.details?.reason ?? "").includes("stale")) {
          setPreview(null);
          setStep("edit");
        }
      } else {
        setError("تعذّر تنفيذ التعديل.");
      }
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`تعديل الفاتورة المؤكدة رقم ${invoice.invoiceNumber} — النسخة الحالية ${currentRevision}`}
      className="w-full max-w-6xl"
    >
      <div className="space-y-4 overflow-y-auto p-4" dir="rtl">
        {error && <Alert variant="error">{error}</Alert>}

        {step === "edit" && (
          <>
            <Alert variant="warning">
              <strong className="block mb-1">تنبيه</strong>
              هذه فاتورة مؤكدة ومرحّلة. عند الاعتماد سيتم عكس أثرها المحاسبي والمخزني الحالي بالكامل وإعادة ترحيلها
              بالبيانات الجديدة. رقم الفاتورة لن يتغير ولن يُحذف أي قيد أو حركة سابقة.
            </Alert>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label>رقم الفاتورة</Label>
                <Input value={invoice.invoiceNumber} readOnly disabled />
              </div>
              <div>
                <Label htmlFor="rev-date">تاريخ الفاتورة</Label>
                <Input id="rev-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="rev-due">تاريخ الاستحقاق</Label>
                <Input id="rev-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
              <div>
                <Label>العميل</Label>
                <SearchableSelect
                  value={customerId}
                  onChange={setCustomerId}
                  options={customers.map((c) => ({ value: c.id, label: c.label }))}
                  placeholder="اختر العميل"
                />
              </div>
              <div>
                <Label>الفرع / المخزن</Label>
                <SearchableSelect
                  value={branchId}
                  onChange={setBranchId}
                  options={branches.map((b) => ({ value: b.id, label: b.label }))}
                  placeholder="اختر الفرع"
                />
              </div>
              <div>
                <Label>المندوب</Label>
                <SearchableSelect
                  value={repId}
                  onChange={setRepId}
                  options={[{ value: "", label: "بدون" }, ...representatives.map((r) => ({ value: r.id, label: r.label }))]}
                  placeholder="بدون"
                />
              </div>
              <div>
                <Label htmlFor="rev-tax">نسبة الضريبة %</Label>
                <Input id="rev-tax" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} inputMode="decimal" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="rev-notes">ملاحظات</Label>
                <Input id="rev-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-sm font-semibold">الأصناف</h4>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setLines((prev) => [
                      ...prev,
                      { productVariantId: "", productLabel: "", quantity: "1", unitPrice: "", costPrice: "0", discountPct: "0", note: "" },
                    ])
                  }
                >
                  إضافة بند
                </Button>
              </div>
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={l.lineId ?? `new-${i}`} className="grid items-end gap-2 rounded border border-border p-2 sm:grid-cols-6">
                    <div className="sm:col-span-2">
                      <Label>الصنف</Label>
                      <SearchableSelect
                        value={l.productVariantId}
                        onChange={(v) => setLine(i, { productVariantId: v })}
                        options={variants.map((v) => ({ value: v.id, label: v.label }))}
                        placeholder="اختر الصنف"
                      />
                    </div>
                    <div>
                      <Label>عدد الألواح</Label>
                      <Input value={l.quantity} inputMode="decimal" onChange={(e) => setLine(i, { quantity: e.target.value })} />
                    </div>
                    <div>
                      <Label>سعر المتر</Label>
                      <Input value={l.unitPrice} inputMode="decimal" onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                    </div>
                    <div>
                      <Label>خصم %</Label>
                      <Input value={l.discountPct} inputMode="decimal" onChange={(e) => setLine(i, { discountPct: e.target.value })} />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        حذف
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <Label htmlFor="rev-reason">{t("sections.reason")} — {t("reasonLabel")}</Label>
              <Input
                id="rev-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="مثال: تصحيح سعر البيع المتفق عليه مع العميل"
                maxLength={500}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>إلغاء</Button>
              <Button onClick={runPreview} disabled={busy || !reasonValid}>
                {busy ? "جارٍ الحساب…" : t("reviewButton")}
              </Button>
            </div>
          </>
        )}

        {step === "review" && preview && (
          <>
            <RevisionComparison
              preview={preview}
              acknowledged={acknowledged}
              onToggleAcknowledged={(code) =>
                setAcknowledged((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]))
              }
            />
            <section className="rounded-lg border border-border p-4">
              <Label htmlFor="rev-reason-review">{t("sections.reason")}</Label>
              <Input id="rev-reason-review" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </section>
            <div className="flex justify-between gap-2">
              <Button variant="secondary" onClick={() => setStep("edit")} disabled={busy}>{t("backToEdit")}</Button>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onClose} disabled={busy}>إلغاء</Button>
                <Button onClick={execute} disabled={!canExecute}>
                  {busy ? "جارٍ الترحيل…" : t("executeButton")}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
