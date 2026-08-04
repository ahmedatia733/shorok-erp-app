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
  executePurchaseRevision,
  newRevisionIdempotencyKey,
  previewPurchaseRevision,
  type InvoiceRevisionPreview,
  type PurchaseRevisionPayload,
} from "../../lib/invoice-revisions-client";
import type { PurchaseInvoiceDetail } from "../../lib/purchase-invoices-client";
import { RevisionComparison } from "./revision-comparison";

/**
 * تعديل فاتورة المشتريات المؤكدة.
 *
 * Same two-step shape as the sales form, but the comparison it shows carries
 * the valuation replay: what a changed purchase cost does to the shared average
 * cost, to the stock still on hand, and to the cost of everything already sold
 * out of it.
 */

interface Option { id: string; label: string }

type LineDraft = {
  lineId?: string;
  productVariantId: string;
  boardsQuantity: string;
  unitPrice: string;
  taxRate: string;
  isFree: boolean;
};

export function PurchaseRevisionModal({
  invoice,
  suppliers,
  branches,
  variants,
  onClose,
  onRevised,
}: {
  invoice: PurchaseInvoiceDetail & { revisionNumber?: number };
  suppliers: Option[];
  branches: Option[];
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
  const [supplierId, setSupplierId] = useState(invoice.supplierId);
  const [branchId, setBranchId] = useState(invoice.branchId);
  const [notes, setNotes] = useState(invoice.notes ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    invoice.lines.map((l) => ({
      lineId: l.id,
      productVariantId: l.productVariantId,
      boardsQuantity: l.boardsQuantity,
      unitPrice: l.unitPrice,
      taxRate: l.taxRate,
      isFree: l.isFree,
    })),
  );

  const payload: PurchaseRevisionPayload = useMemo(
    () => ({
      invoiceDate,
      dueDate: dueDate || null,
      supplierId,
      branchId,
      basedOn: invoice.basedOn ?? null,
      docDirection: invoice.docDirection ?? null,
      customsNumber: invoice.customsNumber ?? null,
      notes: notes || null,
      lines: lines.map((l) => ({
        ...(l.lineId ? { lineId: l.lineId } : {}),
        productVariantId: l.productVariantId,
        boardsQuantity: l.boardsQuantity,
        unitPrice: l.unitPrice,
        taxRate: l.taxRate || "0",
        isFree: l.isFree,
      })),
    }),
    [invoiceDate, dueDate, supplierId, branchId, notes, lines, invoice.basedOn, invoice.docDirection, invoice.customsNumber],
  );

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const reasonValid = reason.trim().length >= 3;
  const canExecute =
    preview != null &&
    preview.blocking.length === 0 &&
    reasonValid &&
    preview.warnings.every((w) => acknowledged.includes(w.code)) &&
    !busy;

  const runPreview = async () => {
    setError(null);
    if (!reasonValid) {
      setError(t("reasonRequired"));
      return;
    }
    setBusy(true);
    try {
      const result = await previewPurchaseRevision(invoice.id, {
        expectedRevisionNumber: currentRevision,
        reason: reason.trim(),
        payload,
      });
      setPreview(result);
      setAcknowledged([]);
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
      const result = await executePurchaseRevision(invoice.id, {
        expectedRevisionNumber: currentRevision,
        previewFingerprint: preview.previewFingerprint,
        reason: reason.trim(),
        idempotencyKey: submitKey,
        acknowledgedWarnings: acknowledged,
        payload,
      });
      onRevised(result.revision.revisionNumber);
    } catch (e) {
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
      title={`تعديل فاتورة المشتريات المؤكدة ${invoice.invoiceNumber} — النسخة الحالية ${currentRevision}`}
      className="w-full max-w-6xl"
    >
      <div className="space-y-4 overflow-y-auto p-4" dir="rtl">
        {error && <Alert variant="error">{error}</Alert>}

        {step === "edit" && (
          <>
            <Alert variant="warning">
              <strong className="block mb-1">تنبيه</strong>
              تعديل فاتورة مشتريات مؤكدة يعيد احتساب متوسط تكلفة الأصناف المشتركة، وقد يؤدي إلى تسوية في قيمة
              المخزون وتكلفة المبيعات للفواتير اللاحقة. سيتم عرض ذلك بالكامل قبل الاعتماد.
            </Alert>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label>رقم الفاتورة</Label>
                <Input value={invoice.invoiceNumber} readOnly disabled />
              </div>
              <div>
                <Label htmlFor="prev-date">تاريخ الفاتورة</Label>
                <Input id="prev-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="prev-due">تاريخ الاستحقاق</Label>
                <Input id="prev-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
              <div>
                <Label>المورد</Label>
                <SearchableSelect
                  value={supplierId}
                  onChange={setSupplierId}
                  options={suppliers.map((s) => ({ value: s.id, label: s.label }))}
                  placeholder="اختر المورد"
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
                <Label htmlFor="prev-notes">ملاحظات</Label>
                <Input id="prev-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-sm font-semibold">الأصناف</h4>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setLines((prev) => [...prev, { productVariantId: "", boardsQuantity: "1", unitPrice: "", taxRate: "0", isFree: false }])
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
                      <Input value={l.boardsQuantity} inputMode="decimal" onChange={(e) => setLine(i, { boardsQuantity: e.target.value })} />
                    </div>
                    <div>
                      <Label>سعر شراء المتر</Label>
                      <Input value={l.unitPrice} inputMode="decimal" onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                    </div>
                    <div>
                      <Label>ضريبة %</Label>
                      <Input value={l.taxRate} inputMode="decimal" onChange={(e) => setLine(i, { taxRate: e.target.value })} />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="danger" onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}>
                        حذف
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <Label htmlFor="prev-reason">{t("sections.reason")} — {t("reasonLabel")}</Label>
              <Input
                id="prev-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="مثال: تصحيح سعر الشراء حسب مستند المورد"
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
              <Label htmlFor="prev-reason-review">{t("sections.reason")}</Label>
              <Input id="prev-reason-review" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
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
