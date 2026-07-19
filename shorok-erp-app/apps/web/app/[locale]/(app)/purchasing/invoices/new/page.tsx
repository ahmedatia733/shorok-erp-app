"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
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
import { AP_COLORS, apColorMap } from "../../../../../../lib/ap-colors";
import { ProductVariantSelect } from "../../../../../../components/features/product-variant-select";
import { type VariantItem } from "../../../../../../lib/variant-select";
import { switchVariantLine } from "../../../../../../lib/variant-line";
import {
  boardArea,
  totalMeters as calcTotalMeters,
  lineTotalPerMeter,
  taxAmount as calcTax,
  BOARD_AREA_LARGE,
  BOARD_AREA_SMALL,
} from "../../../../../../lib/line-calc";

const SIZE_K = BOARD_AREA_LARGE; // كبير — 5.25 م²/لوح
const SIZE_S = BOARD_AREA_SMALL; // صغير — 4 م²/لوح

interface InvoiceLine {
  _key: string;
  colorCode: string;
  productVariantId: string;
  boardsQuantity: string;
  sizeChoice: "" | "K" | "S";
  customL: string;
  customW: string;
  unitLabel: string;
  unitPrice: string;
  taxRate: string;
  metersQuantity: string;
  sqm: string;
  lineTotal: string;
  taxAmount: string;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function mkLine(): InvoiceLine {
  return {
    _key: Math.random().toString(36).slice(2),
    colorCode: "",
    productVariantId: "",
    boardsQuantity: "",
    sizeChoice: "",
    customL: "",
    customW: "",
    unitLabel: "متر",
    unitPrice: "",
    taxRate: "0",
    metersQuantity: "",
    sqm: "",
    lineTotal: "",
    taxAmount: "",
  };
}

function recompute(line: InvoiceLine, variant?: VariantOption): Partial<InvoiceLine> {
  // Area (م²) per board — standard كبير/صغير, custom طول×عرض, or the variant's
  // stored size. All arithmetic is Decimal-safe (see lib/line-calc), so the
  // preview equals what the API posts. Purchase lines price PER METER:
  //   totalMeters = boards × areaPerBoard,  lineTotal = totalMeters × price.
  const perBoard  = boardArea(line.sizeChoice, line.customL, line.customW, variant?.sizeMetersPerBoard ?? "");
  const meters    = calcTotalMeters(line.boardsQuantity || "0", perBoard);
  const lineTotal = lineTotalPerMeter(meters, line.unitPrice || "0");
  const tax       = calcTax(lineTotal, line.taxRate || "0");
  return {
    sqm:            parseFloat(perBoard)  > 0 ? perBoard  : "",
    metersQuantity: parseFloat(meters)    > 0 ? meters    : "",
    lineTotal:      parseFloat(lineTotal) > 0 ? lineTotal : "",
    taxAmount:      parseFloat(tax)       > 0 ? tax       : "",
  };
}

export default function NewPurchaseInvoicePage() {
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const user = useCurrentUser();
  const canCreate = useHasRole("ACCOUNTANT");

  const [invoiceDate, setInvoiceDate] = useState(today());
  const [supplierId, setSupplierId] = useState("");
  const [branchId, setBranchId] = useState("");

  const [lines, setLines] = useState<InvoiceLine[]>([mkLine(), mkLine()]);

  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [variants, setVariants] = useState<VariantOption[]>([]);
  const variantMap = new Map(variants.map((v) => [v.id, v]));
  const variantItems: VariantItem[] = variants.map((v) => ({
    id: v.id, skuCode: v.skuCode, colorNameAr: v.skuNameAr, colorNameEn: v.skuNameEn,
    sizeMetersPerBoard: v.sizeMetersPerBoard, price: v.defaultPurchasePricePerMeter,
  }));

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
    // Clear the previous variant's size overrides and load the new variant's
    // own purchase cost per meter — never keep a stale price or size.
    updateLine(idx, switchVariantLine(vid, variant?.defaultPurchasePricePerMeter));
  }

  const subtotal = lines.reduce((s, l) => s + (parseFloat(l.lineTotal) || 0), 0);
  const totalTax = lines.reduce(
    (s, l) => s + (parseFloat(l.taxAmount) || 0),
    0,
  );
  const grandTotal = subtotal + totalTax;

  async function save() {
    const validLines = lines.filter(
      (l) => l.productVariantId && parseFloat(l.boardsQuantity) > 0,
    );
    if (!supplierId || !branchId || validLines.length === 0) {
      setError("يرجى اختيار المورد والفرع وإضافة بند واحد على الأقل");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const inv = await createPurchaseInvoice({
        invoiceDate,
        supplierId,
        branchId,
        lines: validLines.map((l) => ({
          productVariantId: l.productVariantId,
          colorCode: l.colorCode || undefined,
          boardsQuantity: l.boardsQuantity || "1",
          lengthM: l.customL || (l.sizeChoice === "K" ? String(SIZE_K) : l.sizeChoice === "S" ? String(SIZE_S) : undefined),
          widthM: l.customW || undefined,
          unitLabel: l.unitLabel || undefined,
          unitPrice: l.unitPrice || "0",
          taxRate: l.taxRate || "0",
          isFree: false,
        })),
      });
      router.push(`/${locale}/purchasing/invoices/${inv.id}`);
    } catch {
      setError("حدث خطأ أثناء الحفظ");
      setSaving(false);
    }
  }

  const selectCls = "flex-1 h-7 rounded border border-border bg-surface px-2 text-sm";

  return (
    <div className="space-y-0 bg-background min-h-screen" dir="rtl">
      {/* Top action bar */}
      <div className="flex items-center justify-between bg-surface border-b border-border px-4 py-2">
        <h1 className="font-bold text-base">فاتورة جديدة</h1>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? "جارٍ الحفظ..." : "حفظ كمسودة"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => router.back()}>
            إلغاء
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="error" className="mx-4 mt-2">
          {error}
        </Alert>
      ) : null}

      {/* Header — two column */}
      <div className="bg-surface border-b border-border p-4">
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          {/* Right column */}
          <div className="space-y-2">
            <FieldRow label="رقم الفاتورة">
              <span className="text-xs text-textSecondary italic flex-1">يُولَّد تلقائياً</span>
            </FieldRow>
            <FieldRow label="تاريخ الفاتورة">
              <Input
                type="date"
                dir="ltr"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                className="h-7 text-sm flex-1"
              />
            </FieldRow>
            <FieldRow label="المخزن">
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className={selectCls}
              >
                <option value="">اختر المخزن</option>
                {branches.filter((b) => b.active).map((b) => (
                  <option key={b.id} value={b.id}>
                    {locale === "ar" ? b.nameAr : b.nameEn}
                  </option>
                ))}
              </select>
            </FieldRow>
            <FieldRow label="منشئ السجل">
              <span className="flex-1 text-sm">{user?.name ?? ""}</span>
            </FieldRow>
          </div>

          {/* Left column */}
          <div className="space-y-2">
            <FieldRow label="المورد">
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className={selectCls}
              >
                <option value="">اختر المورد</option>
                {suppliers.filter((s) => s.active).map((s) => (
                  <option key={s.id} value={s.id}>
                    {locale === "ar" ? s.nameAr : s.nameEn}
                  </option>
                ))}
              </select>
            </FieldRow>
            <FieldRow label="الفرع">
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className={selectCls}
              >
                <option value="">اختر الفرع</option>
                {branches.filter((b) => b.active).map((b) => (
                  <option key={b.id} value={b.id}>
                    {locale === "ar" ? b.nameAr : b.nameEn}
                  </option>
                ))}
              </select>
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
              <th className="border border-border px-2 py-1.5 text-center min-w-[240px]">الكود / الصنف</th>
              <th className="border border-border px-2 py-1.5 text-center w-16" title="عدد الألواح">عدد الألواح</th>
              <th className="border border-border px-2 py-1.5 text-center w-16" title="لوح كبير = 5.25 م²">كبير (5.25)</th>
              <th className="border border-border px-2 py-1.5 text-center w-16" title="لوح صغير = 4 م²">صغير (4)</th>
              <th className="border border-border px-2 py-1.5 text-center w-14" title="طول اللوح (مقاس خاص)">طول</th>
              <th className="border border-border px-2 py-1.5 text-center w-14" title="عرض اللوح (مقاس خاص)">عرض</th>

              <th className="border border-border px-2 py-1.5 text-center w-20" title="مساحة اللوح الواحد بالمتر المربع (كبير 5.25 / صغير 4 / طول×عرض)">مساحة اللوح (م²)</th>
              <th className="border border-border px-2 py-1.5 text-center w-24" title="إجمالي المساحة = عدد الألواح × مساحة اللوح">إجمالي المساحة (م²)</th>
              <th className="border border-border px-2 py-1.5 text-center w-24" title="وصف الوحدة">الوحدة</th>
              <th className="border border-border px-2 py-1.5 text-center w-24">سعر الوحدة</th>
              <th className="border border-border px-2 py-1.5 text-center w-24">الإجمالي</th>
              <th className="border border-border px-2 py-1.5 text-center w-14">ضريبة %</th>
              <th className="border border-border px-2 py-1.5 text-center w-20">قيمة الضريبة</th>
              <th className="border border-border px-2 py-1.5 w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => {
              const variant = variantMap.get(line.productVariantId);
              return (
                <tr key={line._key} className="hover:bg-background/50">
                  <td className="border border-border px-1 py-1 text-center text-textSecondary text-xs">
                    {idx + 1}
                  </td>
                  {/* الكود / الصنف — single searchable selector */}
                  <td className="border border-border px-1 py-1">
                    <ProductVariantSelect
                      variants={variantItems}
                      value={line.productVariantId}
                      onChange={(id) => onVariantChange(idx, id)}
                      renderExtra={(v) => (v.price ? `شراء ${v.price}` : null)}
                    />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      data-testid={`pi-boards-${idx}`}
                      value={line.boardsQuantity}
                      onChange={(e) => updateLine(idx, { boardsQuantity: e.target.value })}
                      className="w-full text-center bg-transparent text-sm focus:outline-none"
                      dir="ltr"
                    />
                  </td>
                  {/* ك — كبير 5.25 م² */}
                  <td className="border border-border px-1 py-1 text-center">
                    <button
                      type="button"
                      title="لوح كبير — 5.25 م²"
                      onClick={() => updateLine(idx, { sizeChoice: line.sizeChoice === "K" ? "" : "K" })}
                      className={`w-7 h-7 rounded text-xs font-bold border transition-colors ${
                        line.sizeChoice === "K"
                          ? "bg-primary text-white border-primary"
                          : "border-border text-textSecondary hover:border-primary"
                      }`}
                    >
                      ك
                    </button>
                  </td>
                  {/* ص — صغير 4 م² */}
                  <td className="border border-border px-1 py-1 text-center">
                    <button
                      type="button"
                      title="لوح صغير — 4 م²"
                      onClick={() => updateLine(idx, { sizeChoice: line.sizeChoice === "S" ? "" : "S" })}
                      className={`w-7 h-7 rounded text-xs font-bold border transition-colors ${
                        line.sizeChoice === "S"
                          ? "bg-primary text-white border-primary"
                          : "border-border text-textSecondary hover:border-primary"
                      }`}
                    >
                      ص
                    </button>
                  </td>
                  {/* طول */}
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" step="0.01" value={line.customL}
                      onChange={(e) => updateLine(idx, { customL: e.target.value })}
                      className="w-full text-center bg-transparent text-xs focus:outline-none" dir="ltr" />
                  </td>
                  {/* عرض */}
                  <td className="border border-border px-1 py-1">
                    <input type="number" min="0" step="0.01" value={line.customW}
                      onChange={(e) => updateLine(idx, { customW: e.target.value })}
                      className="w-full text-center bg-transparent text-xs focus:outline-none" dir="ltr" />
                  </td>

                  {/* م² — auto */}
                  <td className="border border-border px-1 py-1 text-center text-xs text-primary font-semibold" dir="ltr" data-testid={`pi-sqm-${idx}`}>
                    {line.sqm}
                  </td>
                  <td className="border border-border px-1 py-1 text-center text-xs" dir="ltr" data-testid={`pi-meters-${idx}`}>
                    {line.metersQuantity}
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input
                      type="text"
                      value={line.unitLabel}
                      onChange={(e) => updateLine(idx, { unitLabel: e.target.value })}
                      className="w-full text-center bg-transparent text-sm focus:outline-none"
                    />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      data-testid={`pi-price-${idx}`}
                      value={line.unitPrice}
                      onChange={(e) => updateLine(idx, { unitPrice: e.target.value })}
                      className="w-full text-center bg-transparent text-sm focus:outline-none"
                      dir="ltr"
                    />
                  </td>
                  <td
                    className="border border-border px-1 py-1 text-center font-semibold text-xs"
                    dir="ltr"
                    data-testid={`pi-total-${idx}`}
                  >
                    {line.lineTotal}
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={line.taxRate}
                      onChange={(e) => updateLine(idx, { taxRate: e.target.value })}
                      className="w-full text-center bg-transparent text-sm focus:outline-none"
                      dir="ltr"
                    />
                  </td>
                  <td className="border border-border px-1 py-1 text-center text-xs" dir="ltr">
                    {line.taxAmount}
                  </td>
                  <td className="border border-border px-1 py-1 text-center">
                    <button
                      type="button"
                      onClick={() => setLines((p) => p.filter((_, i) => i !== idx))}
                      className="text-textSecondary hover:text-danger text-xs"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="border-t border-border p-3 flex items-center justify-between bg-surface">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLines((p) => [...p, mkLine()])}
          >
            إضافة صنف
          </Button>
          <div className="flex gap-6 text-sm" dir="ltr">
            <span className="text-textSecondary">
              المجموع: <strong>{subtotal.toFixed(2)}</strong>
            </span>
            <span className="text-textSecondary">
              الضريبة: <strong>{totalTax.toFixed(2)}</strong>
            </span>
            <span className="font-bold text-base">الإجمالي: {grandTotal.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border pb-1.5">
      <span className="w-28 text-textSecondary shrink-0 text-end text-xs">{label}</span>
      <div className="flex-1 flex items-center">{children}</div>
    </div>
  );
}
