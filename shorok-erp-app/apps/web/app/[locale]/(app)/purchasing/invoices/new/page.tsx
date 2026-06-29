"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Input } from "../../../../../../components/ui/input";
import { useCurrentUser, useHasRole } from "../../../../../../lib/auth";
import { listAllBranches, type BranchRow } from "../../../../../../lib/admin-client";
import { listSuppliers, type SupplierRow } from "../../../../../../lib/suppliers-client";
import {
  createPurchaseInvoice,
  listVariantsForInvoice,
  type VariantOption,
} from "../../../../../../lib/purchase-invoices-client";

interface InvoiceLine {
  _key: string;
  productVariantId: string;
  boardsQuantity: string;
  lengthM: string;
  widthM: string;
  unitLabel: string;
  unitPrice: string;
  taxRate: string;
  taxRate2: string;
  isFree: boolean;
  metersQuantity: string;
  lineTotal: string;
  taxAmount: string;
  taxAmount2: string;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function mkLine(): InvoiceLine {
  return {
    _key: Math.random().toString(36).slice(2),
    productVariantId: "",
    boardsQuantity: "",
    lengthM: "",
    widthM: "",
    unitLabel: "متر",
    unitPrice: "",
    taxRate: "0",
    taxRate2: "0",
    isFree: false,
    metersQuantity: "",
    lineTotal: "",
    taxAmount: "",
    taxAmount2: "",
  };
}

function recompute(line: InvoiceLine, variant?: VariantOption): Partial<InvoiceLine> {
  const boards = parseFloat(line.boardsQuantity) || 0;
  const L = parseFloat(line.lengthM) || 0;
  const W = parseFloat(line.widthM) || 0;
  const size = variant ? parseFloat(variant.sizeMetersPerBoard) : 0;
  let meters = 0;
  if (L > 0 && W > 0) meters = boards * L * W;
  else if (L > 0) meters = boards * L;
  else if (size > 0) meters = boards * size;
  const price = parseFloat(line.unitPrice) || 0;
  const lineTotal = line.isFree ? 0 : meters * price;
  const taxRate = parseFloat(line.taxRate) || 0;
  const taxRate2 = parseFloat(line.taxRate2) || 0;
  const taxAmount = line.isFree ? 0 : (lineTotal * taxRate) / 100;
  const taxAmount2 = line.isFree ? 0 : (lineTotal * taxRate2) / 100;
  return {
    metersQuantity: meters > 0 ? meters.toFixed(4) : "",
    lineTotal: lineTotal > 0 ? lineTotal.toFixed(2) : "",
    taxAmount: taxAmount > 0 ? taxAmount.toFixed(2) : "",
    taxAmount2: taxAmount2 > 0 ? taxAmount2.toFixed(2) : "",
  };
}

export default function NewPurchaseInvoicePage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("purchaseInvoices");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const user = useCurrentUser();
  const canCreate = useHasRole("ACCOUNTANT");

  const [invoiceDate, setInvoiceDate] = useState(today());
  const [dueDate, setDueDate] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [basedOn, setBasedOn] = useState("");
  const [docDirection, setDocDirection] = useState("");
  const [customsNumber, setCustomsNumber] = useState("");
  const [notes, setNotes] = useState("");

  const [lines, setLines] = useState<InvoiceLine[]>([mkLine(), mkLine()]);

  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [variants, setVariants] = useState<VariantOption[]>([]);
  const variantMap = new Map(variants.map((v) => [v.id, v]));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canCreate) { router.replace(`/${locale}/purchasing/invoices`); return; }
    void Promise.all([
      listSuppliers().then(setSuppliers),
      listAllBranches().then(setBranches),
      listVariantsForInvoice().then(setVariants),
    ]);
  }, [canCreate, locale, router]);

  function updateLine(idx: number, patch: Partial<InvoiceLine>) {
    setLines((prev) => {
      const next = [...prev];
      const merged = { ...next[idx]!, ...patch };
      const variant = variantMap.get(merged.productVariantId);
      next[idx] = { ...merged, ...recompute(merged, variant) };
      return next;
    });
  }

  function onVariantChange(idx: number, vid: string) {
    const variant = variantMap.get(vid);
    updateLine(idx, { productVariantId: vid, unitPrice: variant?.defaultPurchasePricePerMeter ?? "", lengthM: "", widthM: "" });
  }

  const subtotal = lines.reduce((s, l) => s + (parseFloat(l.lineTotal) || 0), 0);
  const totalTax = lines.reduce((s, l) => s + (parseFloat(l.taxAmount) || 0) + (parseFloat(l.taxAmount2) || 0), 0);
  const grandTotal = subtotal + totalTax;

  const selectedBranch = branches.find((b) => b.id === branchId);

  async function save() {
    const validLines = lines.filter((l) => l.productVariantId && parseFloat(l.boardsQuantity) > 0);
    if (!supplierId || !branchId || validLines.length === 0) { setError(t("saveFailed")); return; }
    setSaving(true);
    setError(null);
    try {
      const inv = await createPurchaseInvoice({
        invoiceDate,
        dueDate: dueDate || undefined,
        supplierId,
        branchId,
        basedOn: basedOn || undefined,
        docDirection: docDirection || undefined,
        customsNumber: customsNumber || undefined,
        notes: notes || undefined,
        lines: validLines.map((l) => ({
          productVariantId: l.productVariantId,
          boardsQuantity: l.boardsQuantity || "1",
          lengthM: l.lengthM || undefined,
          widthM: l.widthM || undefined,
          unitLabel: l.unitLabel || undefined,
          unitPrice: l.unitPrice || "0",
          taxRate: l.taxRate || "0",
          isFree: l.isFree,
        })),
      });
      router.push(`/${locale}/purchasing/invoices/${inv.id}`);
    } catch {
      setError(t("saveFailed"));
      setSaving(false);
    }
  }

  return (
    <div className="space-y-0 bg-background min-h-screen" dir="rtl">
      {/* Top action bar */}
      <div className="flex items-center justify-between bg-surface border-b border-border px-4 py-2">
        <h1 className="font-bold text-base">{t("newInvoice")}</h1>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? t("saving") : t("saveDraft")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => router.back()}>
            {tCommon("cancel")}
          </Button>
        </div>
      </div>

      {error ? <Alert variant="error" className="mx-4 mt-2">{error}</Alert> : null}

      {/* Header — two column form */}
      <div className="bg-surface border-b border-border p-4">
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          {/* Right column */}
          <div className="space-y-2">
            <FieldRow label={t("invoiceNumber")}>
              <span className="text-xs text-textSecondary italic">
                {locale === "ar" ? "يُولَّد تلقائياً" : "Auto-generated"}
              </span>
            </FieldRow>
            <FieldRow label={t("invoiceDate")}>
              <Input type="date" dir="ltr" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className="h-7 text-sm flex-1" />
            </FieldRow>
            <FieldRow label={t("dueDate")}>
              <Input type="date" dir="ltr" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="h-7 text-sm flex-1" />
            </FieldRow>
            <FieldRow label={t("branch")}>
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)}
                className="flex-1 h-7 rounded border border-border bg-surface px-2 text-sm">
                <option value="">{t("selectBranch")}</option>
                {branches.filter((b) => b.active).map((b) => (
                  <option key={b.id} value={b.id}>{locale === "ar" ? b.nameAr : b.nameEn}</option>
                ))}
              </select>
            </FieldRow>
            <FieldRow label={t("notes")}>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                className="flex-1 rounded border border-border bg-surface px-2 py-1 text-sm resize-none" />
            </FieldRow>
            <FieldRow label={t("customsNumber")}>
              <Input dir="ltr" value={customsNumber} onChange={(e) => setCustomsNumber(e.target.value)} className="h-7 text-sm flex-1" />
            </FieldRow>
            <FieldRow label={t("createdBy")}>
              <span className="flex-1 text-sm">{user?.name ?? ""}</span>
            </FieldRow>
          </div>

          {/* Left column */}
          <div className="space-y-2">
            <FieldRow label={t("docDirection")}>
              <Input value={docDirection} onChange={(e) => setDocDirection(e.target.value)} className="h-7 text-sm flex-1" />
            </FieldRow>
            <FieldRow label={t("actualDate")}>
              <span className="flex-1 text-sm" dir="ltr">{invoiceDate}</span>
            </FieldRow>
            <FieldRow label={t("basedOn")}>
              <Input value={basedOn} onChange={(e) => setBasedOn(e.target.value)} className="h-7 text-sm flex-1" />
            </FieldRow>
            <FieldRow label={t("supplier")}>
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
                className="flex-1 h-7 rounded border border-border bg-surface px-2 text-sm">
                <option value="">{t("selectSupplier")}</option>
                {suppliers.filter((s) => s.active).map((s) => (
                  <option key={s.id} value={s.id}>{locale === "ar" ? s.nameAr : s.nameEn}</option>
                ))}
              </select>
            </FieldRow>
            <FieldRow label={t("branchLabel")}>
              <span className="flex-1 text-sm">
                {selectedBranch ? (locale === "ar" ? selectedBranch.nameAr : selectedBranch.nameEn) : "—"}
              </span>
            </FieldRow>
          </div>
        </div>
      </div>

      {/* Lines table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-background text-textSecondary text-xs">
              <th className="border border-border px-2 py-1.5 text-center w-8">#</th>
              <th className="border border-border px-2 py-1.5 text-center w-20">{t("lineCode")}</th>
              <th className="border border-border px-2 py-1.5 text-center min-w-[180px]">{t("lineProduct")}</th>
              <th className="border border-border px-2 py-1.5 text-center w-16">{locale === "ar" ? "عدد" : "Qty"}</th>
              <th className="border border-border px-2 py-1.5 text-center w-16">{locale === "ar" ? "ط" : "L"}</th>
              <th className="border border-border px-2 py-1.5 text-center w-16">{locale === "ar" ? "ع" : "W"}</th>
              <th className="border border-border px-2 py-1.5 text-center w-20">{t("lineMeters")}</th>
              <th className="border border-border px-2 py-1.5 text-center w-24">{t("lineUnit")}</th>
              <th className="border border-border px-2 py-1.5 text-center w-24">{t("lineUnitPrice")}</th>
              <th className="border border-border px-2 py-1.5 text-center w-24">{t("lineTotal")}</th>
              <th className="border border-border px-2 py-1.5 text-center w-14">{t("lineFree")}</th>
              <th className="border border-border px-2 py-1.5 text-center w-14">{t("lineTaxRate")} %</th>
              <th className="border border-border px-2 py-1.5 text-center w-20">{t("lineTaxAmount")}</th>
              <th className="border border-border px-2 py-1.5 text-center w-14">{t("lineTaxRate")} 2%</th>
              <th className="border border-border px-2 py-1.5 text-center w-20">{t("lineTaxAmount")} 2</th>
              <th className="border border-border px-2 py-1.5 w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => {
              const variant = variantMap.get(line.productVariantId);
              return (
                <tr key={line._key} className="hover:bg-background/50">
                  <td className="border border-border px-1 py-1 text-center text-textSecondary text-xs">{idx + 1}</td>
                  <td className="border border-border px-1 py-1 text-center font-mono text-xs text-textSecondary">
                    {variant?.skuCode ?? ""}
                  </td>
                  <td className="border border-border px-1 py-1">
                    <select value={line.productVariantId} onChange={(e) => onVariantChange(idx, e.target.value)}
                      className="w-full bg-transparent text-sm focus:outline-none">
                      <option value="">{t("selectVariant")}</option>
                      {variants.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.skuCode} — {locale === "ar" ? v.skuNameAr : v.skuNameEn} ({v.sizeMetersPerBoard}م)
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" step="1" value={line.boardsQuantity}
                      onChange={(e) => updateLine(idx, { boardsQuantity: e.target.value })}
                      className="w-full text-center bg-transparent text-sm focus:outline-none" dir="ltr" />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" step="0.01" value={line.lengthM}
                      onChange={(e) => updateLine(idx, { lengthM: e.target.value })}
                      placeholder={variant?.sizeMetersPerBoard ?? ""}
                      className="w-full text-center bg-transparent text-sm focus:outline-none" dir="ltr" />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" step="0.01" value={line.widthM}
                      onChange={(e) => updateLine(idx, { widthM: e.target.value })}
                      className="w-full text-center bg-transparent text-sm focus:outline-none" dir="ltr" />
                  </td>
                  <td className="border border-border px-1 py-1 text-center text-xs" dir="ltr">{line.metersQuantity}</td>
                  <td className="border border-border px-1 py-1">
                    <input type="text" value={line.unitLabel}
                      onChange={(e) => updateLine(idx, { unitLabel: e.target.value })}
                      className="w-full text-center bg-transparent text-sm focus:outline-none" />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" step="0.01" value={line.unitPrice}
                      onChange={(e) => updateLine(idx, { unitPrice: e.target.value })}
                      disabled={line.isFree}
                      className="w-full text-center bg-transparent text-sm focus:outline-none disabled:opacity-50" dir="ltr" />
                  </td>
                  <td className="border border-border px-1 py-1 text-center font-semibold text-xs" dir="ltr">{line.lineTotal}</td>
                  <td className="border border-border px-1 py-1 text-center">
                    <input type="checkbox" checked={line.isFree}
                      onChange={(e) => updateLine(idx, { isFree: e.target.checked })} className="h-4 w-4" />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" max="100" step="0.01" value={line.taxRate}
                      onChange={(e) => updateLine(idx, { taxRate: e.target.value })}
                      disabled={line.isFree}
                      className="w-full text-center bg-transparent text-sm focus:outline-none disabled:opacity-50" dir="ltr" />
                  </td>
                  <td className="border border-border px-1 py-1 text-center text-xs" dir="ltr">{line.taxAmount}</td>
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" max="100" step="0.01" value={line.taxRate2}
                      onChange={(e) => updateLine(idx, { taxRate2: e.target.value })}
                      disabled={line.isFree}
                      className="w-full text-center bg-transparent text-sm focus:outline-none disabled:opacity-50" dir="ltr" />
                  </td>
                  <td className="border border-border px-1 py-1 text-center text-xs" dir="ltr">{line.taxAmount2}</td>
                  <td className="border border-border px-1 py-1 text-center">
                    <button type="button" onClick={() => setLines((p) => p.filter((_, i) => i !== idx))}
                      className="text-textSecondary hover:text-danger text-xs">✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="border-t border-border p-3 flex items-center justify-between bg-surface">
          <Button variant="secondary" size="sm" onClick={() => setLines((p) => [...p, mkLine()])}>
            {t("addLine")}
          </Button>
          <div className="flex gap-6 text-sm" dir="ltr">
            <span className="text-textSecondary">{t("subtotal")}: <strong>{subtotal.toFixed(2)}</strong></span>
            <span className="text-textSecondary">{t("taxAmount")}: <strong>{totalTax.toFixed(2)}</strong></span>
            <span className="font-bold text-base">{t("grandTotal")}: {grandTotal.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border pb-1.5">
      <span className="w-36 text-textSecondary shrink-0 text-end text-xs">{label}</span>
      <div className="flex-1 flex items-center">{children}</div>
    </div>
  );
}
