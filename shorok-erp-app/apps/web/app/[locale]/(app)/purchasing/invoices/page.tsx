"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Modal } from "../../../../../components/ui/modal";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { useHasRole } from "../../../../../lib/auth";
import {
  listPurchaseInvoices,
  confirmPurchaseInvoice,
  cancelPurchaseInvoice,
  deletePurchaseInvoice,
  type PurchaseInvoiceRow,
} from "../../../../../lib/purchase-invoices-client";
import { listAccounts, type AccountRow } from "../../../../../lib/accounts-client";
import { AP_COLORS, apColorMap } from "../../../../../lib/ap-colors";
import { formatDate, formatCurrency } from "../../../../../lib/format";

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmt(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return isNaN(n) ? "—" : n.toLocaleString("ar-EG", { minimumFractionDigits: 2 });
}

function autoSelect(accounts: AccountRow[], ...keywords: string[]): string {
  const kws = keywords.map((k) => k.toLowerCase());
  const match = accounts.find((a) =>
    kws.some((k) => a.nameAr.toLowerCase().includes(k) || (a.nameEn ?? "").toLowerCase().includes(k)),
  );
  return match?.id ?? "";
}

// ─── StatusBadge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    DRAFT:     "bg-yellow-100 text-yellow-800",
    CONFIRMED: "bg-green-100 text-green-800",
    CANCELLED: "bg-gray-100 text-gray-600",
  };
  const labels: Record<string, string> = {
    DRAFT: "مسودة", CONFIRMED: "مؤكدة", CANCELLED: "ملغاة",
  };
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${map[status] ?? ""}`}>
      {labels[status] ?? status}
    </span>
  );
}

// ─── AccountSelector ─────────────────────────────────────────────────────────

function AccountSelector({
  label, hint, amountLabel, amount,
  value, onChange, options, required,
  linkPath, linkLabel,
  locale,
}: {
  label: string; hint?: string; amountLabel: string; amount: string;
  value: string; onChange: (v: string) => void;
  options: AccountRow[]; required?: boolean;
  linkPath?: string; linkLabel?: string;
  locale: AppLocale;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">
          {label} {required && <span className="text-red-500">*</span>}
        </label>
        {value && linkPath && (
          <a
            href={`/${locale}/${linkPath}?accountId=${value}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-600 hover:underline"
          >
            {linkLabel ?? "عرض كشف الحساب"}
          </a>
        )}
      </div>
      {hint && <p className="text-xs text-textSecondary">{hint}</p>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
      >
        <option value="">— اختر الحساب —</option>
        {options.map((a) => (
          <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
        ))}
      </select>
      <div className="text-xs text-textSecondary flex justify-between">
        <span>{amountLabel}</span>
        <span className="font-semibold" dir="ltr">{fmt(amount)} ج.م</span>
      </div>
    </div>
  );
}

// ─── ConfirmModal ─────────────────────────────────────────────────────────────

function ConfirmModal({
  invoice,
  onClose,
  onConfirmed,
  locale,
}: {
  invoice: PurchaseInvoiceRow;
  onClose: () => void;
  onConfirmed: (updated: PurchaseInvoiceRow) => void;
  locale: AppLocale;
}) {
  const [leafAccounts, setLeafAccounts] = useState<AccountRow[]>([]);
  const [apAccountId,        setApAccountId]        = useState("");
  const [taxAccountId,       setTaxAccountId]       = useState("");
  const [inventoryAccountId, setInventoryAccountId] = useState("");
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const subtotal   = parseFloat(invoice.subtotal);
  const taxAmount  = parseFloat(invoice.taxAmount);
  const grandTotal = parseFloat(invoice.grandTotal);
  const hasTax     = taxAmount > 0;

  useEffect(() => {
    void listAccounts().then((all) => {
      const leaf = all.filter((a) => a.isLeaf && a.active);
      setLeafAccounts(leaf);

      const liabilityAccs = leaf.filter((a) => a.category === "LIABILITY");
      const assetAccs     = leaf.filter((a) => a.category === "ASSET");

      // AP account: موردون / دائنون / payable / creditor
      const apMatch =
        autoSelect(liabilityAccs, "موردون", "دائنون", "payable", "creditor") ||
        autoSelect(leaf,          "موردون", "دائنون", "payable", "creditor") ||
        (liabilityAccs[0]?.id ?? "");
      setApAccountId(apMatch);

      // Tax account: ضريبة / مدخلات / vat / tax
      const taxKw = leaf.filter((a) => /ضريبة|ضرائب|vat|tax/i.test(a.nameAr + (a.nameEn ?? "")));
      setTaxAccountId(taxKw[0]?.id ?? liabilityAccs[0]?.id ?? "");

      // Inventory account: مخزون / بضاعة / inventory / stock
      setInventoryAccountId(
        autoSelect(assetAccs, "مخزون", "بضاعة", "inventory", "stock") ||
        autoSelect(leaf,      "مخزون", "بضاعة", "inventory", "stock"),
      );
    });
  }, []);

  async function handleConfirm() {
    if (!apAccountId) { setError("يرجى اختيار حساب الموردين والدائنين"); return; }
    setSaving(true);
    setError(null);
    try {
      const updated = await confirmPurchaseInvoice(invoice.id, {
        apAccountId,
        taxAccountId:       taxAccountId       || undefined,
        inventoryAccountId: inventoryAccountId || undefined,
      });
      onConfirmed(updated);
    } catch {
      setError("فشل تأكيد الفاتورة، تحقق من البيانات وحاول مجدداً");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="تأكيد فاتورة مشتريات">
      <div className="space-y-5 text-sm" dir="rtl">
        {error && <Alert variant="error">{error}</Alert>}

        {/* Supplier / Invoice summary card */}
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-bold text-blue-800 text-base">{invoice.supplierNameAr}</div>
              <div className="text-xs text-blue-600 mt-0.5">
                فاتورة مشتريات #{invoice.invoiceNumber} — {invoice.invoiceDate}
              </div>
              {invoice.branchNameAr && (
                <div className="text-xs text-blue-500">الفرع: {invoice.branchNameAr}</div>
              )}
            </div>
            <div className="text-end">
              <div className="text-xs text-blue-600">الإجمالي</div>
              <div className="font-bold text-blue-800 text-lg" dir="ltr">{fmt(grandTotal)} ج.م</div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs border-t border-blue-200 pt-2">
            <div>
              <div className="text-blue-500">المجموع (قبل ض)</div>
              <div className="font-semibold text-blue-700" dir="ltr">{fmt(subtotal)}</div>
            </div>
            <div>
              <div className="text-blue-500">الضريبة</div>
              <div className="font-semibold text-blue-700" dir="ltr">{fmt(taxAmount)}</div>
            </div>
            <div>
              <div className="text-blue-500">الإجمالي النهائي</div>
              <div className="font-bold text-blue-800" dir="ltr">{fmt(grandTotal)}</div>
            </div>
          </div>
        </div>

        {/* القيد المحاسبي */}
        <div className="rounded-md bg-surface border border-border p-3 text-xs space-y-1 font-mono">
          <div className="font-semibold text-textSecondary mb-1">القيد المحاسبي:</div>
          {inventoryAccountId && (
            <div className="flex justify-between">
              <span className="text-foreground">مدين — المخزون</span>
              <span dir="ltr">{fmt(subtotal)}</span>
            </div>
          )}
          {hasTax && taxAccountId && (
            <div className="flex justify-between">
              <span className="text-foreground">مدين — ضريبة المدخلات</span>
              <span dir="ltr">{fmt(taxAmount)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-dashed border-border pt-1">
            <span className="text-foreground">دائن — الموردون والدائنون</span>
            <span dir="ltr">{fmt(grandTotal)}</span>
          </div>
        </div>

        {/* Account selectors */}
        <div className="space-y-4">
          <AccountSelector
            label="حساب الموردين والدائنين (AP)"
            hint="الذمم الدائنة — ما يستحقه المورد"
            amountLabel="يُضاف للدائن"
            amount={invoice.grandTotal}
            value={apAccountId}
            onChange={setApAccountId}
            options={leafAccounts}
            required
            locale={locale}
            linkPath="accounting/statement"
            linkLabel="عرض كشف الحساب"
          />

          <AccountSelector
            label={`حساب ضريبة المدخلات${!hasTax ? " (لا توجد ضريبة)" : ""}`}
            hint="ضريبة القيمة المضافة على المشتريات"
            amountLabel="يُضاف للمدين"
            amount={invoice.taxAmount}
            value={taxAccountId}
            onChange={setTaxAccountId}
            options={leafAccounts}
            locale={locale}
            linkPath="accounting/tax"
            linkLabel="عرض حساب الضريبة"
          />

          <AccountSelector
            label="حساب المخزون"
            hint="قيمة البضاعة الواردة"
            amountLabel="يُضاف للمدين"
            amount={invoice.subtotal}
            value={inventoryAccountId}
            onChange={setInventoryAccountId}
            options={leafAccounts}
            locale={locale}
            linkPath="accounting/statement"
            linkLabel="عرض كشف الحساب المحاسبي"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button variant="ghost" onClick={onClose} disabled={saving}>إلغاء</Button>
          <Button onClick={() => void handleConfirm()} disabled={saving || !apAccountId}>
            {saving ? "جار التأكيد..." : "تأكيد الفاتورة"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── ExpandedRow ─────────────────────────────────────────────────────────────

function ExpandedRow({
  invoice,
  locale,
}: {
  invoice: PurchaseInvoiceRow;
  locale: AppLocale;
}) {
  return (
    <div className="p-4 bg-gray-50 text-sm space-y-3" dir="rtl">
      {/* Lines table */}
      <div className="overflow-x-auto">
        <Table>
          <THead>
            <TR>
              <TH>اللون</TH>
              <TH>المنتج</TH>
              <TH>العدد</TH>
              <TH>م²</TH>
              <TH>الكمية (م)</TH>
              <TH>سعر الوحدة</TH>
              <TH>الضريبة%</TH>
              <TH>الضريبة</TH>
              <TH>الإجمالي</TH>
            </TR>
          </THead>
          <TBody>
            {invoice.lines.map((l) => {
              const color = apColorMap.get(l.colorCode ?? "");
              return (
                <TR key={l.id}>
                  <TD>
                    {color ? (
                      <span className="text-xs">{color.nameAr}</span>
                    ) : (
                      <span className="text-xs text-textSecondary">{l.colorCode ?? "—"}</span>
                    )}
                  </TD>
                  <TD className="text-xs">
                    <span className="font-mono">{l.skuCode}</span>
                    {l.skuNameAr && <span className="ms-1 text-textSecondary">— {l.skuNameAr}</span>}
                  </TD>
                  <TD className="text-xs">{l.boardsQuantity}</TD>
                  <TD className="text-xs">
                    {l.lengthM && l.widthM
                      ? `${l.lengthM}×${l.widthM}`
                      : parseFloat(l.sizeMetersPerBoard).toFixed(2)}
                  </TD>
                  <TD className="text-xs">{parseFloat(l.metersQuantity).toFixed(2)}</TD>
                  <TD className="text-xs" dir="ltr">{fmt(l.unitPrice)}</TD>
                  <TD className="text-xs">{l.taxRate}%</TD>
                  <TD className="text-xs text-blue-600" dir="ltr">
                    {parseFloat(l.taxAmount) > 0 ? fmt(l.taxAmount) : "—"}
                  </TD>
                  <TD className="text-xs font-semibold" dir="ltr">
                    {l.isFree
                      ? <span className="text-green-600 text-xs">مجاني</span>
                      : fmt(l.lineTotal)}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-3 gap-2 text-xs bg-white rounded border border-border p-3">
        <div>المجموع (قبل ض): <span className="font-semibold" dir="ltr">{fmt(invoice.subtotal)}</span></div>
        <div className="text-blue-600">الضريبة: <span className="font-semibold" dir="ltr">{fmt(invoice.taxAmount)}</span></div>
        <div className="font-bold">الإجمالي: <span dir="ltr">{fmt(invoice.grandTotal)}</span></div>
        {invoice.basedOn   && <div className="col-span-3 text-textSecondary">مبني على: {invoice.basedOn}</div>}
        {invoice.notes     && <div className="col-span-3 text-textSecondary">ملاحظات: {invoice.notes}</div>}
      </div>

      {/* Account links after confirmation */}
      {invoice.status === "CONFIRMED" && (
        <div className="bg-white rounded border border-border p-3 space-y-2">
          <div className="text-xs font-semibold text-textSecondary">كشوف الحسابات المرتبطة</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {invoice.apAccountId && (
              <a
                href={`/${locale}/accounting/statement?accountId=${invoice.apAccountId}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                ← عرض كشف الموردين والدائنين
              </a>
            )}
            {invoice.taxAccountId && (
              <a
                href={`/${locale}/accounting/tax?accountId=${invoice.taxAccountId}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                ← عرض حساب ضريبة المدخلات
              </a>
            )}
            {invoice.branchId && (
              <a
                href={`/${locale}/inventory/movements?branchId=${invoice.branchId}&referenceId=${invoice.id}&referenceType=purchase_invoice`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                ← عرض حركات المخزون
              </a>
            )}
          </div>
          {invoice.journalEntryId && (
            <div className="flex gap-2 pt-1">
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 text-green-800 px-2 py-0.5 text-xs">
                قيد #{invoice.journalEntryId.slice(0, 8)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PurchaseInvoicesPage() {
  const locale    = useLocale() as AppLocale;
  const t         = useTranslations("purchaseInvoices");
  const tCommon   = useTranslations("common");
  const router    = useRouter();
  const isOwner   = useHasRole();
  const canCreate = useHasRole("ACCOUNTANT");

  const [invoices,        setInvoices]        = useState<PurchaseInvoiceRow[]>([]);
  const [expandedDetails, setExpandedDetails] = useState<Record<string, PurchaseInvoiceRow>>({});
  const [expandedIds,     setExpandedIds]     = useState<Set<string>>(new Set());
  const [nextCursor,      setNextCursor]      = useState<string | null>(null);
  const [error,           setError]           = useState<string | null>(null);
  const [loadingMore,     setLoadingMore]     = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const [confirmingInv,   setConfirmingInv]   = useState<PurchaseInvoiceRow | null>(null);
  const [listSearch,      setListSearch]      = useState("");

  const displayedInvoices = listSearch
    ? invoices.filter((inv) =>
        (inv.invoiceNumber + " " + inv.supplierNameAr)
          .toLowerCase()
          .includes(listSearch.toLowerCase()),
      )
    : invoices;

  const loadInvoices = useCallback(async (cursor?: string | null) => {
    try {
      const page = await listPurchaseInvoices({ limit: 20, cursor });
      if (cursor) {
        setInvoices((prev) => [...prev, ...page.data]);
      } else {
        setInvoices(page.data);
      }
      setNextCursor(page.nextCursor);
    } catch {
      setError(t("loadFailed"));
    }
  }, [t]);

  useEffect(() => { void loadInvoices(); }, [loadInvoices]);

  function toggleExpand(inv: PurchaseInvoiceRow) {
    if (expandedIds.has(inv.id)) {
      setExpandedIds((prev) => { const s = new Set(prev); s.delete(inv.id); return s; });
      return;
    }
    setExpandedDetails((prev) => ({ ...prev, [inv.id]: inv }));
    setExpandedIds((prev) => new Set(prev).add(inv.id));
  }

  async function handleDelete(id: string) {
    try {
      await deletePurchaseInvoice(id);
      setDeleteConfirmId(null);
      setInvoices((prev) => prev.filter((inv) => inv.id !== id));
    } catch {
      setError(tCommon("actionFailed"));
    }
  }

  async function handleCancel(id: string) {
    try {
      await cancelPurchaseInvoice(id);
      setCancelConfirmId(null);
      setInvoices((prev) =>
        prev.map((inv) =>
          inv.id === id
            ? { ...inv, status: "CANCELLED", journalEntryId: null, apAccountId: null, taxAccountId: null, inventoryAccountId: null }
            : inv,
        ),
      );
    } catch {
      setError("فشل إلغاء الفاتورة");
    }
  }

  function handleConfirmed(updated: PurchaseInvoiceRow) {
    setInvoices((prev) => prev.map((inv) => inv.id === updated.id ? updated : inv));
    setExpandedDetails((prev) => ({ ...prev, [updated.id]: updated }));
    setExpandedIds((prev) => new Set(prev).add(updated.id));
    setConfirmingInv(null);
  }

  async function loadMore() {
    setLoadingMore(true);
    await loadInvoices(nextCursor);
    setLoadingMore(false);
  }

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t("title")}</h1>
        {(isOwner || canCreate) && (
          <Button onClick={() => router.push(`/${locale}/purchasing/invoices/new`)}>
            {t("newInvoice")}
          </Button>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="flex items-center gap-3">
        <Input
          placeholder="بحث برقم الفاتورة أو اسم المورد..."
          value={listSearch}
          onChange={(e) => setListSearch(e.target.value)}
          className="max-w-sm border-2 border-primary/40 bg-background"
        />
        {listSearch && (
          <button type="button" className="text-xs text-textSecondary hover:text-text" onClick={() => setListSearch("")}>
            مسح ✕
          </button>
        )}
      </div>

      <Card>
        <CardBody className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>{t("invoiceNumber")}</TH>
                <TH>{t("invoiceDate")}</TH>
                <TH>{t("supplier")}</TH>
                <TH>{t("branch")}</TH>
                <TH>الضريبة</TH>
                <TH>{t("grandTotal")}</TH>
                <TH>{t("status")}</TH>
                <TH>{tCommon("actions")}</TH>
              </TR>
            </THead>
            <TBody>
              {displayedInvoices.length === 0 && (
                <TR>
                  <TD colSpan={8} className="text-center text-textSecondary py-8">
                    {listSearch ? "لا توجد نتائج مطابقة" : t("empty")}
                  </TD>
                </TR>
              )}

              {displayedInvoices.map((inv) => {
                const isExpanded      = expandedIds.has(inv.id);
                const detail          = expandedDetails[inv.id] ?? inv;
                const confirmingDel   = deleteConfirmId === inv.id;
                const confirmingCancel = cancelConfirmId === inv.id;

                return (
                  <tbody key={inv.id}>
                    <TR
                      className="cursor-pointer hover:bg-background"
                      onClick={() => router.push(`/${locale}/purchasing/invoices/${inv.id}`)}
                    >
                      <TD className="font-mono text-sm">{inv.invoiceNumber}</TD>
                      <TD>{formatDate(inv.invoiceDate, locale)}</TD>
                      <TD>{inv.supplierNameAr}</TD>
                      <TD>{inv.branchNameAr}</TD>
                      <TD className="text-blue-600 text-xs" dir="ltr">
                        {parseFloat(inv.taxAmount) > 0 ? fmt(inv.taxAmount) : "—"}
                      </TD>
                      <TD className="font-semibold" dir="ltr">{formatCurrency(inv.grandTotal, locale)}</TD>
                      <TD><StatusBadge status={inv.status} /></TD>
                      <TD onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1 flex-wrap">

                          {/* Expand details */}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleExpand(inv)}
                          >
                            {isExpanded ? "إخفاء" : "تفاصيل"}
                          </Button>

                          {/* Confirm (DRAFT only) */}
                          {isOwner && inv.status === "DRAFT" && (
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => setConfirmingInv(inv)}
                            >
                              تأكيد
                            </Button>
                          )}

                          {/* Cancel (CONFIRMED only) */}
                          {isOwner && inv.status === "CONFIRMED" && (
                            confirmingCancel ? (
                              <div className="flex items-center gap-1 text-xs">
                                <span>إلغاء؟</span>
                                <Button size="sm" variant="danger" onClick={() => void handleCancel(inv.id)}>نعم</Button>
                                <Button size="sm" variant="ghost" onClick={() => setCancelConfirmId(null)}>لا</Button>
                              </div>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setCancelConfirmId(inv.id)}
                              >
                                إلغاء
                              </Button>
                            )
                          )}

                          {/* Delete (DRAFT only) */}
                          {isOwner && inv.status === "DRAFT" && (
                            confirmingDel ? (
                              <div className="flex items-center gap-1 text-xs">
                                <span>{t("deletePrompt")}</span>
                                <Button size="sm" variant="danger" onClick={() => void handleDelete(inv.id)}>{tCommon("yes")}</Button>
                                <Button size="sm" variant="ghost" onClick={() => setDeleteConfirmId(null)}>{tCommon("no")}</Button>
                              </div>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setDeleteConfirmId(inv.id)}
                              >
                                {tCommon("delete")}
                              </Button>
                            )
                          )}
                        </div>
                      </TD>
                    </TR>

                    {/* Expanded details row */}
                    {isExpanded && (
                      <tr>
                        <td colSpan={8} className="p-0">
                          <ExpandedRow invoice={detail} locale={locale} />
                        </td>
                      </tr>
                    )}
                  </tbody>
                );
              })}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      {nextCursor && (
        <div className="text-center">
          <Button variant="ghost" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? tCommon("loading") : tCommon("loadMore")}
          </Button>
        </div>
      )}

      {/* Confirm modal */}
      {confirmingInv && (
        <ConfirmModal
          invoice={confirmingInv}
          locale={locale}
          onClose={() => setConfirmingInv(null)}
          onConfirmed={handleConfirmed}
        />
      )}
    </div>
  );
}
