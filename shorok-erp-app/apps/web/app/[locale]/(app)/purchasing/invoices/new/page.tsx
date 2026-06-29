"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Input } from "../../../../../../components/ui/input";
import { createPurchaseInvoice } from "../../../../../../lib/purchase-invoices-client";
import { listSuppliers, type SupplierRow } from "../../../../../../lib/suppliers-client";
import { listAllBranches, type BranchRow } from "../../../../../../lib/admin-client";
import { apiCall } from "../../../../../../lib/api-client";


interface VariantOption {
  id: string;
  skuId: string;
  sizeMetersPerBoard: string;
  defaultPurchasePricePerMeter: string;
  active: boolean;
  sku: {
    id: string;
    code: string;
    colorNameAr: string;
    colorNameEn: string;
    active: boolean;
  };
}

interface LineState {
  productVariantId: string;
  boardsQuantity: string;
  unitPrice: string;
  taxRate: string;
  isFree: boolean;
}

function computeMeters(boardsQty: string, sizeMetersPerBoard: string): string {
  try {
    const b = parseFloat(boardsQty || "0");
    const s = parseFloat(sizeMetersPerBoard || "0");
    if (isNaN(b) || isNaN(s)) return "0.0000";
    return (b * s).toFixed(4);
  } catch {
    return "0.0000";
  }
}

function computeLineTotal(metersQty: string, unitPrice: string, isFree: boolean): string {
  if (isFree) return "0.00";
  try {
    const m = parseFloat(metersQty || "0");
    const p = parseFloat(unitPrice || "0");
    if (isNaN(m) || isNaN(p)) return "0.00";
    return (m * p).toFixed(2);
  } catch {
    return "0.00";
  }
}

function computeTaxAmount(lineTotal: string, taxRate: string, isFree: boolean): string {
  if (isFree) return "0.00";
  try {
    const tot = parseFloat(lineTotal || "0");
    const r = parseFloat(taxRate || "0");
    if (isNaN(tot) || isNaN(r)) return "0.00";
    return ((tot * r) / 100).toFixed(2);
  } catch {
    return "0.00";
  }
}

export default function NewPurchaseInvoicePage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("purchaseInvoices");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [variants, setVariants] = useState<VariantOption[]>([]);

  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [supplierId, setSupplierId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineState[]>([
    { productVariantId: "", boardsQuantity: "1", unitPrice: "0", taxRate: "0", isFree: false },
  ]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listSuppliers().then((res) =>
      setSuppliers(res.filter((s) => s.active)),
    );
    void listAllBranches().then((res) =>
      setBranches(res.filter((b) => b.active)),
    );
    void apiCall<VariantOption[]>("/products/variants?active=true").then((res) =>
      setVariants(res.filter((v) => v.active && v.sku.active)),
    );
  }, []);

  function getVariant(id: string): VariantOption | undefined {
    return variants.find((v) => v.id === id);
  }

  function updateLine(idx: number, field: keyof LineState, value: string | boolean) {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        const updated = { ...l, [field]: value };
        // Auto-fill unit price when variant changes
        if (field === "productVariantId" && typeof value === "string") {
          const v = getVariant(value);
          if (v) updated.unitPrice = v.defaultPurchasePricePerMeter;
        }
        return updated;
      }),
    );
  }

  function addLine() {
    setLines((prev) => [
      ...prev,
      { productVariantId: "", boardsQuantity: "1", unitPrice: "0", taxRate: "0", isFree: false },
    ]);
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  // Compute totals
  const computedLines = lines.map((l) => {
    const variant = getVariant(l.productVariantId);
    const sizeM = variant?.sizeMetersPerBoard ?? "0";
    const metersQty = computeMeters(l.boardsQuantity, sizeM);
    const lineTotal = computeLineTotal(metersQty, l.unitPrice, l.isFree);
    const taxAmt = computeTaxAmount(lineTotal, l.taxRate, l.isFree);
    return { ...l, metersQty, lineTotal, taxAmt };
  });

  const subtotal = computedLines
    .reduce((acc, l) => acc + parseFloat(l.lineTotal), 0)
    .toFixed(2);
  const totalTax = computedLines
    .reduce((acc, l) => acc + parseFloat(l.taxAmt), 0)
    .toFixed(2);
  const grandTotal = (parseFloat(subtotal) + parseFloat(totalTax)).toFixed(2);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!supplierId || !branchId) {
      setError(t("saveFailed"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const invoice = await createPurchaseInvoice({
        invoiceDate,
        supplierId,
        branchId,
        notes: notes || undefined,
        lines: computedLines.map((l) => ({
          productVariantId: l.productVariantId,
          boardsQuantity: l.boardsQuantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
          isFree: l.isFree,
        })),
      });
      router.push(`/${locale}/purchasing/invoices/${invoice.id}`);
    } catch {
      setError(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          {tCommon("back")}
        </Button>
        <h1 className="text-xl font-bold">{t("newInvoice")}</h1>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6">
        {/* Header fields */}
        <Card>
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm mb-1">{t("invoiceDate")}</label>
                <Input
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-sm mb-1">{t("supplier")}</label>
                <select
                  className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  required
                >
                  <option value="">—</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {locale === "ar" ? s.nameAr : s.nameEn}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">{t("branch")}</label>
                <select
                  className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                  required
                >
                  <option value="">—</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {locale === "ar" ? b.nameAr : b.nameEn}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">{t("notes")}</label>
                <textarea
                  className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={1000}
                />
              </div>
            </div>
          </CardBody>
        </Card>

        {/* Lines table */}
        <Card>
          <CardHeader>
            <CardTitle>{t("lines")}</CardTitle>
          </CardHeader>
          <CardBody className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-background">
                <tr>
                  <th className="px-3 py-2 text-start">{t("lineProduct")}</th>
                  <th className="px-3 py-2 text-start">{t("lineBoards")}</th>
                  <th className="px-3 py-2 text-start">{t("lineUnit")}</th>
                  <th className="px-3 py-2 text-start">{t("lineMeters")}</th>
                  <th className="px-3 py-2 text-start">{t("lineUnitPrice")}</th>
                  <th className="px-3 py-2 text-start">{t("lineTotal")}</th>
                  <th className="px-3 py-2 text-start">{t("lineFree")}</th>
                  <th className="px-3 py-2 text-start">{t("lineTaxRate")}</th>
                  <th className="px-3 py-2 text-start">{t("lineTaxAmount")}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {computedLines.map((line, idx) => {
                  const variant = getVariant(line.productVariantId);
                  return (
                    <tr key={idx} className="border-b border-border last:border-0">
                      <td className="px-2 py-1 min-w-[200px]">
                        <select
                          className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                          value={line.productVariantId}
                          onChange={(e) => updateLine(idx, "productVariantId", e.target.value)}
                          required
                        >
                          <option value="">—</option>
                          {variants.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.sku.code} — {locale === "ar" ? v.sku.colorNameAr : v.sku.colorNameEn} — {v.sizeMetersPerBoard}م
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          className="w-20"
                          value={line.boardsQuantity}
                          onChange={(e) => updateLine(idx, "boardsQuantity", e.target.value)}
                          inputMode="decimal"
                          required
                        />
                      </td>
                      <td className="px-2 py-1 text-textSecondary text-xs">
                        {variant?.sizeMetersPerBoard ?? "—"}
                      </td>
                      <td className="px-2 py-1 text-textSecondary">
                        {line.metersQty}
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          className="w-24"
                          value={line.unitPrice}
                          onChange={(e) => updateLine(idx, "unitPrice", e.target.value)}
                          inputMode="decimal"
                          required
                        />
                      </td>
                      <td className="px-2 py-1 text-textSecondary">{line.lineTotal}</td>
                      <td className="px-2 py-1 text-center">
                        <input
                          type="checkbox"
                          checked={line.isFree}
                          onChange={(e) => updateLine(idx, "isFree", e.target.checked)}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          className="w-16"
                          value={line.taxRate}
                          onChange={(e) => updateLine(idx, "taxRate", e.target.value)}
                          inputMode="decimal"
                        />
                      </td>
                      <td className="px-2 py-1 text-textSecondary">{line.taxAmt}</td>
                      <td className="px-2 py-1">
                        {lines.length > 1 && (
                          <button
                            type="button"
                            className="text-danger text-xs"
                            onClick={() => removeLine(idx)}
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardBody>
        </Card>

        {/* Footer */}
        <div className="flex items-start justify-between gap-4">
          <Button type="button" variant="ghost" onClick={addLine}>
            {t("addLine")}
          </Button>

          <div className="space-y-1 text-sm text-end">
            <div>
              <span className="text-textSecondary me-2">{t("subtotal")}:</span>
              <span className="font-medium">{subtotal}</span>
            </div>
            <div>
              <span className="text-textSecondary me-2">{t("taxAmount")}:</span>
              <span className="font-medium">{totalTax}</span>
            </div>
            <div className="text-base font-bold">
              <span className="me-2">{t("grandTotal")}:</span>
              <span>{grandTotal}</span>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? tCommon("loading") : t("saveDraft")}
          </Button>
        </div>
      </form>
    </div>
  );
}
