"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../i18n";
import { Alert } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Modal } from "../../ui/modal";
import { SearchableSelect } from "../../ui/searchable-select";
import { ProductCreateModal } from "../products/product-create-modal";
import { ApiClientError } from "../../../lib/api-client";
import { useHasRole } from "../../../lib/auth";
import { formatCurrency } from "../../../lib/format";
import { lineTotalPerMeter, totalMeters } from "../../../lib/line-calc";
import { purchaseLineSize } from "../../../lib/purchase-line-size";
import { createCustomer, listCustomers, type CustomerRow } from "../../../lib/customers-client";
import { listPurchaseCatalogue, type PurchaseCatalogueProduct } from "../../../lib/purchase-invoices-client";
import { createLegacyReturn, type LegacyReturnLinePayload } from "../../../lib/legacy-returns-client";

interface BranchOption {
  id: string;
  nameAr: string;
  active: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  customers: CustomerRow[];
  branches: BranchOption[];
  onCustomersChanged: (next: CustomerRow[]) => void;
  onCreated: () => void;
}

interface DraftLine {
  key: string;
  productSkuId: string;
  sizeChoice: "" | "K" | "S";
  customL: string;
  customW: string;
  boards: string;
  unitPrice: string;
  note: string;
}

const newLine = (): DraftLine => ({
  key: Math.random().toString(36).slice(2),
  productSkuId: "",
  sizeChoice: "",
  customL: "",
  customW: "",
  boards: "",
  unitPrice: "",
  note: "",
});

const today = () => new Date().toISOString().slice(0, 10);

/**
 * «+ إضافة مرتجع بدون فاتورة».
 *
 * The operator is standing at the counter with the customer's old paper invoice
 * in front of him, so the form asks for what only that paper knows — its
 * number, its date, and the price the customer actually paid. Everything else
 * comes from the system.
 *
 * The product list is the Product Master, not saleable stock: a return is
 * precisely the case where the item may currently have none. And the size is
 * chosen on the line the same way a purchase chooses it, which is what lets a
 * board this product has never been recorded at come back in.
 */
export function LegacyReturnFormModal({
  open,
  onClose,
  customers,
  branches,
  onCustomersChanged,
  onCreated,
}: Props) {
  const locale = useLocale() as AppLocale;
  // Product and customer master data are OWNER-only to create; this form only
  // ever offers what the person is actually allowed to do.
  const canCreateProduct = useHasRole("OWNER");

  const [customerId, setCustomerId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [paperInvoiceNumber, setPaperInvoiceNumber] = useState("");
  const [paperInvoiceDate, setPaperInvoiceDate] = useState("");
  const [returnDate, setReturnDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);

  const [products, setProducts] = useState<PurchaseCatalogueProduct[]>([]);
  const [productModalLine, setProductModalLine] = useState<number | null>(null);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [customerSaving, setCustomerSaving] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCustomerId("");
    setBranchId(branches[0]?.id ?? "");
    setPaperInvoiceNumber("");
    setPaperInvoiceDate("");
    setReturnDate(today());
    setNotes("");
    setLines([newLine()]);
    setError(null);
    void listPurchaseCatalogue().then(setProducts).catch(() => setProducts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const update = (idx: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  /** Metres and money for one line, using the shared Decimal-safe helpers. */
  const compute = (l: DraftLine) => {
    const size = purchaseLineSize(l);
    if (!size || !l.boards || Number(l.boards) <= 0) return { size, meters: "0", total: "0" };
    const meters = totalMeters(l.boards, size);
    return { size, meters, total: lineTotalPerMeter(meters, l.unitPrice || "0") };
  };

  const grandTotal = lines.reduce((acc, l) => acc + Number(compute(l).total || 0), 0);

  const readyLines = lines
    .map((l) => ({ line: l, calc: compute(l) }))
    .filter(({ line, calc }) => line.productSkuId && calc.size && Number(line.boards) > 0 && line.unitPrice !== "");

  const canSubmit =
    Boolean(customerId && branchId && paperInvoiceNumber.trim() && paperInvoiceDate && returnDate) &&
    readyLines.length > 0 &&
    !saving;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const payload: LegacyReturnLinePayload[] = readyLines.map(({ line, calc }) => ({
        productSkuId: line.productSkuId,
        sizeMetersPerBoard: calc.size!,
        ...(line.sizeChoice === "" && line.customL ? { lengthM: line.customL } : {}),
        ...(line.sizeChoice === "" && line.customW ? { widthM: line.customW } : {}),
        returnedBoards: line.boards,
        unitPricePerMeter: line.unitPrice,
        ...(line.note.trim() ? { note: line.note.trim() } : {}),
      }));
      await createLegacyReturn({
        customerId,
        branchId,
        paperInvoiceNumber: paperInvoiceNumber.trim(),
        paperInvoiceDate,
        returnDate,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: payload,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.localizedMessage(locale) : "تعذّر حفظ المرتجع.");
    } finally {
      setSaving(false);
    }
  };

  const saveCustomer = async () => {
    if (!newCustomerName.trim()) return;
    setCustomerSaving(true);
    try {
      const created = await createCustomer({
        nameAr: newCustomerName.trim(),
        ...(newCustomerPhone.trim() ? { phone: newCustomerPhone.trim() } : {}),
      });
      // Refetch so the picker holds the master list, then select the new one —
      // the option exists before it is chosen, and nothing else on the form moves.
      const fresh = await listCustomers().catch(() => [...customers, created]);
      onCustomersChanged(fresh);
      setCustomerId(created.id);
      setCustomerModalOpen(false);
      setNewCustomerName("");
      setNewCustomerPhone("");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.localizedMessage(locale) : "تعذّر إضافة العميل.");
    } finally {
      setCustomerSaving(false);
    }
  };

  return (
    <>
      <Modal open={open} onClose={onClose} title="إضافة مرتجع بدون فاتورة" className="max-w-5xl w-full">
        <form onSubmit={submit} className="space-y-4" noValidate dir="rtl">
          {error && <Alert variant="error">{error}</Alert>}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label htmlFor="lrf-customer">العميل</Label>
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <SearchableSelect
                    id="lrf-customer"
                    testId="lrf-customer"
                    value={customerId}
                    onChange={setCustomerId}
                    placeholder="— اختر العميل —"
                    options={customers.map((c) => ({
                      value: c.id,
                      label: c.code ? `${c.code} — ${c.nameAr}` : c.nameAr,
                      keywords: [c.code ?? "", c.nameAr, c.phone ?? ""].join(" "),
                    }))}
                    clearable
                  />
                </div>
                <button
                  type="button"
                  title="إضافة عميل جديد"
                  data-testid="lrf-add-customer"
                  onClick={() => setCustomerModalOpen(true)}
                  className="shrink-0 rounded border border-success bg-success-bg px-2 py-2 text-xs font-bold text-success-foreground hover:opacity-90"
                >
                  +
                </button>
              </div>
            </div>

            <div>
              <Label htmlFor="lrf-branch">المخزن المستلم</Label>
              <select
                id="lrf-branch"
                data-testid="lrf-branch"
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                <option value="">— اختر المخزن —</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.nameAr}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="lrf-return-date">تاريخ المرتجع</Label>
              <Input
                id="lrf-return-date"
                type="date"
                value={returnDate}
                onChange={(e) => setReturnDate(e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="lrf-paper">رقم الفاتورة الورقية</Label>
              <Input
                id="lrf-paper"
                data-testid="lrf-paper"
                value={paperInvoiceNumber}
                onChange={(e) => setPaperInvoiceNumber(e.target.value)}
                maxLength={120}
                placeholder="كما هو مكتوب على الورق"
              />
            </div>

            <div>
              <Label htmlFor="lrf-paper-date">تاريخ الفاتورة الأصلية</Label>
              <Input
                id="lrf-paper-date"
                data-testid="lrf-paper-date"
                type="date"
                value={paperInvoiceDate}
                onChange={(e) => setPaperInvoiceDate(e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="lrf-notes">ملاحظات</Label>
              <Input id="lrf-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-background">
                  <th className="border border-border px-2 py-1.5 text-start">الصنف</th>
                  <th className="border border-border px-2 py-1.5 w-14">ك</th>
                  <th className="border border-border px-2 py-1.5 w-14">ص</th>
                  <th className="border border-border px-2 py-1.5 w-24">الطول</th>
                  <th className="border border-border px-2 py-1.5 w-24">العرض</th>
                  <th className="border border-border px-2 py-1.5 w-20">الألواح</th>
                  <th className="border border-border px-2 py-1.5 w-24">الأمتار</th>
                  <th className="border border-border px-2 py-1.5 w-28">سعر المتر</th>
                  <th className="border border-border px-2 py-1.5 w-28">الإجمالي</th>
                  <th className="border border-border px-2 py-1.5 w-8" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => {
                  const calc = compute(line);
                  return (
                    <tr key={line.key}>
                      <td className="border border-border px-1 py-1">
                        <div className="flex items-start gap-1">
                          <div className="min-w-0 flex-1">
                            <SearchableSelect
                              testId={`lrf-product-${idx}`}
                              value={line.productSkuId}
                              onChange={(v) => update(idx, { productSkuId: v })}
                              placeholder="— اختر الصنف —"
                              emptyText="لا توجد أصناف"
                              options={products.map((p) => ({
                                value: p.productSkuId,
                                label: `${p.code} — ${p.nameAr}`,
                                keywords: [p.code, p.nameAr, p.nameEn].filter(Boolean).join(" "),
                              }))}
                              clearable
                            />
                          </div>
                          {canCreateProduct && (
                            <button
                              type="button"
                              title="إضافة صنف جديد"
                              data-testid={`lrf-add-product-${idx}`}
                              onClick={() => setProductModalLine(idx)}
                              className="shrink-0 rounded border border-success bg-success-bg px-2 py-1 text-xs font-bold text-success-foreground hover:opacity-90"
                            >
                              +
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="border border-border px-1 py-1 text-center">
                        <button
                          type="button"
                          title="لوح كبير — 5.25 م"
                          data-testid={`lrf-k-${idx}`}
                          onClick={() => update(idx, { sizeChoice: line.sizeChoice === "K" ? "" : "K", customL: "", customW: "" })}
                          className={`h-7 w-7 rounded border text-xs font-bold ${
                            line.sizeChoice === "K" ? "border-primary bg-primary text-white" : "border-border text-textSecondary"
                          }`}
                        >
                          ك
                        </button>
                      </td>
                      <td className="border border-border px-1 py-1 text-center">
                        <button
                          type="button"
                          title="لوح صغير — 4.00 م"
                          data-testid={`lrf-s-${idx}`}
                          onClick={() => update(idx, { sizeChoice: line.sizeChoice === "S" ? "" : "S", customL: "", customW: "" })}
                          className={`h-7 w-7 rounded border text-xs font-bold ${
                            line.sizeChoice === "S" ? "border-primary bg-primary text-white" : "border-border text-textSecondary"
                          }`}
                        >
                          ص
                        </button>
                      </td>
                      <td className="border border-border px-1 py-1">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          dir="ltr"
                          data-testid={`lrf-length-${idx}`}
                          value={line.customL}
                          onChange={(e) => update(idx, { customL: e.target.value, sizeChoice: "" })}
                          className="w-full bg-transparent text-center text-xs focus:outline-none"
                        />
                      </td>
                      <td className="border border-border px-1 py-1">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          dir="ltr"
                          value={line.customW}
                          onChange={(e) => update(idx, { customW: e.target.value, sizeChoice: "" })}
                          className="w-full bg-transparent text-center text-xs focus:outline-none"
                        />
                      </td>
                      <td className="border border-border px-1 py-1">
                        <input
                          inputMode="numeric"
                          dir="ltr"
                          data-testid={`lrf-boards-${idx}`}
                          value={line.boards}
                          onChange={(e) => update(idx, { boards: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                          className="w-full bg-transparent text-center text-sm focus:outline-none"
                        />
                      </td>
                      <td className="border border-border px-1 py-1 text-center text-xs text-primary" dir="ltr">
                        {Number(calc.meters) > 0 ? calc.meters : ""}
                      </td>
                      <td className="border border-border px-1 py-1">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          dir="ltr"
                          data-testid={`lrf-price-${idx}`}
                          value={line.unitPrice}
                          onChange={(e) => update(idx, { unitPrice: e.target.value })}
                          className="w-full bg-transparent text-center text-sm focus:outline-none"
                        />
                      </td>
                      <td className="border border-border px-1 py-1 text-center text-xs" dir="ltr">
                        {Number(calc.total) > 0 ? calc.total : ""}
                      </td>
                      <td className="border border-border px-1 py-1 text-center">
                        {lines.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setLines((p) => p.filter((_, i) => i !== idx))}
                            className="text-danger"
                            title="حذف السطر"
                          >
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button type="button" variant="ghost" onClick={() => setLines((p) => [...p, newLine()])}>
              + إضافة سطر
            </Button>
            <span className="text-sm">
              إجمالي قيمة المرتجع: <b dir="ltr">{formatCurrency(grandTotal.toFixed(2), locale)}</b>
            </span>
          </div>

          <p className="rounded-md border border-border bg-background p-2 text-xs text-textSecondary">
            يُحفظ المستند كمسودة أولاً. عند التأكيد تُضاف البضاعة إلى مخزون الفرع المحدد وتُضاف قيمة المرتجع إلى
            حساب العميل — ولا يوجد أي صرف نقدي أو بنكي. سعر المتر يُؤخذ من الفاتورة الورقية، أما تكلفة المخزون
            فيحسبها النظام من متوسط التكلفة الحالي عند التأكيد.
          </p>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              إلغاء
            </Button>
            <Button type="submit" variant="success" data-testid="lrf-submit" disabled={!canSubmit}>
              {saving ? "جارٍ الحفظ…" : "حفظ كمسودة"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Quick-add a customer — the real Customer Master, no return-only record. */}
      <Modal
        open={customerModalOpen}
        onClose={() => !customerSaving && setCustomerModalOpen(false)}
        title="عميل جديد"
        className="max-w-md w-full"
      >
        <div className="space-y-3" dir="rtl">
          <div>
            <Label htmlFor="lrf-new-cust">اسم العميل بالعربية</Label>
            <Input
              id="lrf-new-cust"
              data-testid="lrf-new-customer-name"
              value={newCustomerName}
              onChange={(e) => setNewCustomerName(e.target.value)}
              maxLength={200}
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="lrf-new-phone">رقم الهاتف (اختياري)</Label>
            <Input
              id="lrf-new-phone"
              dir="ltr"
              value={newCustomerPhone}
              onChange={(e) => setNewCustomerPhone(e.target.value)}
              maxLength={30}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setCustomerModalOpen(false)} disabled={customerSaving}>
              إلغاء
            </Button>
            <Button type="button" onClick={() => void saveCustomer()} disabled={customerSaving || !newCustomerName.trim()}>
              {customerSaving ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Quick-add a product — the same Product Master modal the rest of the
          ERP uses. No size is asked for here: the size belongs to the line. */}
      <ProductCreateModal
        open={productModalLine !== null}
        onClose={() => setProductModalLine(null)}
        onCreated={(product) => {
          const idx = productModalLine;
          setProductModalLine(null);
          if (idx === null) return;
          void listPurchaseCatalogue().then((rows) => {
            setProducts(rows);
            update(idx, { productSkuId: product.id });
          });
        }}
      />
    </>
  );
}
