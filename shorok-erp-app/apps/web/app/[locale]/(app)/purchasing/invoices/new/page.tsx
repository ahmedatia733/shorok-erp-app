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
  listPurchaseCatalogue,
  type PurchaseCatalogueProduct,
} from "../../../../../../lib/purchase-invoices-client";
import { AP_COLORS, apColorMap } from "../../../../../../lib/ap-colors";
import { ProductVariantSelect } from "../../../../../../components/features/product-variant-select";
import { ProductCreateModal } from "../../../../../../components/features/products/product-create-modal";
import { type VariantItem } from "../../../../../../lib/variant-select";
import { purchaseLineSize } from "../../../../../../lib/purchase-line-size";
import { switchVariantLine } from "../../../../../../lib/variant-line";
import {
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
  productSkuId: string;
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
    productSkuId: "",
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

function recompute(line: InvoiceLine): Partial<InvoiceLine> {
  // Area (م²) per board — standard كبير/صغير, custom طول×عرض, or the variant's
  // stored size. All arithmetic is Decimal-safe (see lib/line-calc), so the
  // preview equals what the API posts. Purchase lines price PER METER:
  //   totalMeters = boards × areaPerBoard,  lineTotal = totalMeters × price.
  // The size is whatever was chosen on THIS line — ك, ص or a custom board.
  // Nothing falls back to a previously stored size, because the size is what
  // decides which exact ProductVariant this purchase lands on.
  const perBoard  = purchaseLineSize(line) ?? "0";
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
  // Product master creation is OWNER-only today (POST /products/skus), and this
  // task does not widen that. The button is shown only to whoever may actually
  // use it rather than offering an action that would be refused.
  const canAddProduct = useHasRole("OWNER");

  const [invoiceDate, setInvoiceDate] = useState(today());
  const [supplierId, setSupplierId] = useState("");
  const [branchId, setBranchId] = useState("");

  const [lines, setLines] = useState<InvoiceLine[]>([mkLine(), mkLine()]);

  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [products, setProducts] = useState<PurchaseCatalogueProduct[]>([]);
  // Which line opened the add-product dialog, so the new product lands on the
  // line the user was actually filling in.
  const [quickAddLine, setQuickAddLine] = useState<number | null>(null);
  const productMap = new Map(products.map((p) => [p.productSkuId, p]));

  /** Every active base product, each once, with the sizes it already has. */
  const productItems: VariantItem[] = products.map((p) => ({
    id: p.productSkuId,
    skuCode: p.code,
    colorNameAr: p.nameAr,
    colorNameEn: p.nameEn,
    sizeMetersPerBoard: "",
    price: p.initialPurchasePricePerMeter ?? undefined,
  }));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canCreate) { router.replace(`/${locale}/purchasing/invoices`); return; }
    void Promise.all([
      listSuppliers().then(setSuppliers),
      listAllBranches().then(setBranches),
      // The purchase catalogue is base products, so a product that has never
      // been bought — and therefore has no sizes yet — is still offered here.
      listPurchaseCatalogue().then(setProducts),
    ]);
  }, [canCreate, locale, router]);

  function updateLine(idx: number, patch: Partial<InvoiceLine>) {
    setLines((prev) => {
      const next = [...prev];
      const merged = { ...next[idx]!, ...patch };
      next[idx] = { ...merged, ...recompute(merged) };
      return next;
    });
  }

  function onProductChange(idx: number, skuId: string) {
    const product = productMap.get(skuId);
    // A different product means a different price and a size that was chosen
    // for something else — neither may carry over. The shared reset helper is
    // keyed on a variant id because the sales line still is; here the identity
    // is the base product, so its id is taken and the variant key dropped.
    const { productVariantId: _dropped, ...reset } = switchVariantLine(
      skuId,
      product?.initialPurchasePricePerMeter ?? undefined,
    );
    updateLine(idx, { ...reset, productSkuId: skuId });
  }

  const subtotal = lines.reduce((s, l) => s + (parseFloat(l.lineTotal) || 0), 0);
  const totalTax = lines.reduce(
    (s, l) => s + (parseFloat(l.taxAmount) || 0),
    0,
  );
  const grandTotal = subtotal + totalTax;

  async function save() {
    // A line is ready when it names a product, a real size and a quantity. The
    // size is required because it is what decides the exact ProductVariant this
    // purchase lands on — it is never guessed on the user's behalf.
    const validLines = lines
      .map((l) => ({ line: l, size: purchaseLineSize(l) }))
      .filter(({ line, size }) => line.productSkuId && size && parseFloat(line.boardsQuantity) > 0);
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
        lines: validLines.map(({ line: l, size }) => ({
          productSkuId: l.productSkuId,
          sizeMetersPerBoard: size!,
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
              return (
                <tr key={line._key} className="hover:bg-background/50">
                  <td className="border border-border px-1 py-1 text-center text-textSecondary text-xs">
                    {idx + 1}
                  </td>
                  {/* الكود / الصنف — single searchable selector */}
                  <td className="border border-border px-1 py-1">
                    <div className="flex items-center gap-1">
                      <div className="min-w-0 flex-1">
                        <ProductVariantSelect
                          variants={productItems}
                          value={line.productSkuId}
                          onChange={(id) => onProductChange(idx, id)}
                          renderExtra={(v) => (v.price ? `شراء ${v.price}` : null)}
                        />
                      </div>
                      {canAddProduct && (
                        <button
                          type="button"
                          title="إضافة صنف جديد"
                          data-testid={`pi-add-product-${idx}`}
                          onClick={() => setQuickAddLine(idx)}
                          className="shrink-0 rounded border border-success bg-success-bg px-2 py-1 text-xs font-bold text-success-foreground hover:opacity-90"
                        >
                          + صنف
                        </button>
                      )}
                    </div>
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

      <ProductCreateModal
        open={quickAddLine !== null}
        onClose={() => setQuickAddLine(null)}
        // A purchase line has nothing to post against without an exact size, so
        // this is the one place the form asks for one.
        withSize
        onCreated={(product, enteredPrice) => {
          const line = quickAddLine;
          setQuickAddLine(null);
          if (line === null) return;
          // Refetch so the new product is a real option before it is selected,
          // then put it on the line the user was filling in with the price they
          // just typed. No reload, and nothing else on the invoice moves.
          void listPurchaseCatalogue().then((rows: PurchaseCatalogueProduct[]) => {
            setProducts(rows);
            updateLine(line, { productSkuId: product.id, unitPrice: enteredPrice });
          });
        }}
      />
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
