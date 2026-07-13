"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { Alert } from "../../../../../components/ui/alert";
import { sourceDocumentHref } from "../../../../../lib/source-document";
import { Button } from "../../../../../components/ui/button";
import { Input } from "../../../../../components/ui/input";
import { Modal } from "../../../../../components/ui/modal";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { useHasRole } from "../../../../../lib/auth";
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  getCustomerStatement,
  createCustomerTransaction,
  type CustomerRow,
  type CustomerStatement,
} from "../../../../../lib/customers-client";
import {
  listPaymentAccounts,
  type PaymentAccount,
} from "../../../../../lib/payments-client";

type TxType = "INVOICE" | "RECEIPT" | "RETURN" | "ADJUSTMENT" | "OPENING";

const TX_TYPE_OPTIONS: { value: TxType; label: string; direction: "DR" | "CR" | null }[] = [
  { value: "INVOICE", label: "فاتورة مبيعات", direction: "DR" },
  { value: "RECEIPT", label: "تحصيل", direction: "CR" },
  { value: "RETURN", label: "مرتجع مبيعات", direction: "CR" },
  { value: "ADJUSTMENT", label: "تسوية مدينة", direction: "DR" },
  { value: "ADJUSTMENT", label: "تسوية دائنة", direction: "CR" },
  { value: "OPENING", label: "رصيد افتتاحي", direction: null },
];

function fmt(v: string | number) {
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function BalanceText({ v }: { v: string }) {
  const n = parseFloat(v);
  if (n < 0) {
    return <span className="text-red-600">({fmt(Math.abs(n))})</span>;
  }
  return <span className="text-textPrimary">{fmt(n)}</span>;
}

export default function CustomerStatementPage() {
  const isOwner = useHasRole();
  const canRecord = useHasRole("ACCOUNTANT");

  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);

  // Pre-select customer if customerId is in URL params
  const initCustomerId =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("customerId") ?? ""
      : "";
  const [selectedId, setSelectedId] = useState(initCustomerId);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CustomerStatement | null>(null);
  const locale = useLocale();

  // ─── Customer create/edit modal ───────────────────────────────────────────
  const [custModalOpen,  setCustModalOpen]  = useState(false);
  const [custEditId,     setCustEditId]     = useState<string | null>(null);
  const [custNameAr,     setCustNameAr]     = useState("");
  const [custPhone,      setCustPhone]      = useState("");
  const [custActive,     setCustActive]     = useState(true);
  const [custSaving,     setCustSaving]     = useState(false);
  const [custError,      setCustError]      = useState<string | null>(null);

  function openCreateCustomer() {
    setCustEditId(null); setCustNameAr(""); setCustPhone(""); setCustActive(true);
    setCustError(null); setCustModalOpen(true);
  }

  async function openEditCustomer(id: string) {
    const c = await getCustomer(id);
    setCustEditId(id); setCustNameAr(c.nameAr); setCustPhone(c.phone ?? "");
    setCustActive(c.active); setCustError(null); setCustModalOpen(true);
  }

  async function handleSaveCustomer(e: React.FormEvent) {
    e.preventDefault();
    if (!custNameAr.trim()) return;
    setCustSaving(true); setCustError(null);
    try {
      if (custEditId) {
        const updated = await updateCustomer(custEditId, {
          nameAr: custNameAr.trim(),
          phone: custPhone.trim() || null,
          active: custActive,
        });
        setCustomers((prev) => prev.map((c) => c.id === custEditId ? updated : c));
      } else {
        const created = await createCustomer({
          nameAr: custNameAr.trim(),
          phone: custPhone.trim() || undefined,
        });
        setCustomers((prev) => [...prev, created].sort((a, b) => a.code.localeCompare(b.code)));
        setSelectedId(created.id);
      }
      setCustModalOpen(false);
    } catch {
      setCustError("فشل حفظ بيانات العميل");
    } finally {
      setCustSaving(false);
    }
  }

  // Transaction modal state
  const [txModalOpen, setTxModalOpen] = useState(false);
  const [txCustomerId, setTxCustomerId] = useState("");
  const [txTypeIdx, setTxTypeIdx] = useState(0);
  const [txDate, setTxDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [txAmount, setTxAmount] = useState("");
  const [txReference, setTxReference] = useState("");
  const [txDescription, setTxDescription] = useState("");
  const [txPaymentAccountId, setTxPaymentAccountId] = useState("");
  const [txOpeningDirection, setTxOpeningDirection] = useState<"DR" | "CR">("DR");
  const [txSaving, setTxSaving] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [c, a] = await Promise.all([listCustomers(), listPaymentAccounts()]);
      setCustomers(c);
      setAccounts(a);
      if (a.length > 0 && a[0]) setTxPaymentAccountId(a[0].id);
      // Auto-load if customerId was in URL params
      if (initCustomerId) await load(initCustomerId);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(idOverride?: string) {
    const id = idOverride ?? selectedId;
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setData(await getCustomerStatement(id, from || undefined, to || undefined));
    } catch {
      setError("حدث خطأ أثناء تحميل كشف الحساب");
    } finally {
      setLoading(false);
    }
  }

  function openTxModal() {
    setTxError(null);
    setTxCustomerId(selectedId || "");
    setTxTypeIdx(0);
    setTxDate(new Date().toISOString().slice(0, 10));
    setTxAmount("");
    setTxReference("");
    setTxDescription("");
    setTxOpeningDirection("DR");
    setTxModalOpen(true);
  }

  const selectedTxType = TX_TYPE_OPTIONS[txTypeIdx]!;
  const effectiveDirection = selectedTxType.direction ?? txOpeningDirection;

  async function handleCreateTx(e: React.FormEvent) {
    e.preventDefault();
    const customerId = txCustomerId || selectedId;
    if (!customerId || !txAmount) return;
    setTxSaving(true);
    setTxError(null);
    try {
      await createCustomerTransaction({
        customerId,
        type: selectedTxType.value,
        direction: effectiveDirection,
        amount: Number(txAmount).toFixed(2),
        date: txDate,
        reference: txReference || undefined,
        description: txDescription || undefined,
        paymentAccountId: selectedTxType.value === "RECEIPT" ? txPaymentAccountId || undefined : undefined,
      });
      setTxModalOpen(false);
      if (selectedId === customerId || !selectedId) {
        setSelectedId(customerId);
        await load(customerId);
      }
    } catch {
      setTxError("فشل تسجيل الحركة، تأكد من البيانات");
    } finally {
      setTxSaving(false);
    }
  }


  const entries = data ? data.entries : [];

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">كشف حساب عميل</h1>
        <div className="flex gap-2">
          {canRecord && <Button variant="ghost" onClick={openTxModal}>+ تسجيل حركة</Button>}
          {canRecord && (
            <Button onClick={openCreateCustomer}>+ عميل جديد</Button>
          )}
        </div>
      </div>

      {/* Filters toolbar */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-textSecondary">اختر العميل</label>
              {selectedId && canRecord && (
                <button
                  type="button"
                  className="text-xs text-blue-600 hover:underline"
                  onClick={() => void openEditCustomer(selectedId)}
                >
                  تعديل
                </button>
              )}
            </div>
            <select
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
              value={selectedId}
              onChange={(e) => { setSelectedId(e.target.value); setData(null); }}
            >
              <option value="">— اختر —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.nameAr}{c.active ? "" : " (غير نشط)"}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-textSecondary mb-1">من تاريخ</label>
            <input
              type="date"
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs text-textSecondary mb-1">إلى تاريخ</label>
            <input
              type="date"
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>

          <div className="flex items-end">
            <Button onClick={() => void load()} disabled={!selectedId || loading} className="w-full">
              {loading ? "جار التحميل..." : "عرض"}
            </Button>
          </div>
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {loading && (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
        </div>
      )}

      {data && !loading && (
        <div className="space-y-4">
          {/* Summary box */}
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x md:divide-x-reverse divide-border">
              <div className="p-4 text-center">
                <div className="text-xs text-textSecondary mb-1">رصيد ما قبله</div>
                <div className="font-bold text-lg">
                  <BalanceText v={data.openingBalance} />
                </div>
              </div>
              <div className="p-4">
                <div className="text-xs text-textSecondary text-center mb-2">الحركة</div>
                <div className="grid grid-cols-2 gap-3 text-center">
                  <div>
                    <div className="text-sm font-semibold text-red-600">{fmt(data.totalDR)}</div>
                    <div className="text-xs text-textSecondary">مدين</div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-green-600">{fmt(data.totalCR)}</div>
                    <div className="text-xs text-textSecondary">دائن</div>
                  </div>
                </div>
              </div>
              <div className="p-4 text-center">
                <div className="text-xs text-textSecondary mb-1">الرصيد</div>
                <div className="font-bold text-lg">
                  <BalanceText v={data.closingBalance} />
                </div>
              </div>
            </div>
            <div className="border-t border-border px-4 py-2 text-sm flex gap-2">
              <span className="text-textSecondary">عميل:</span>
              <span className="font-medium">{data.customer.code}</span>
              <span className="text-textSecondary">|</span>
              <span>{data.customer.nameAr}</span>
            </div>
          </div>

          {/* Statement table */}
          <Table>
            <THead>
              <TR>
                <TH rowSpan={2}>م</TH>
                <TH rowSpan={2}>تاريخ</TH>
                <TH rowSpan={2}>بناءاً على</TH>
                <TH rowSpan={2}>الشرح</TH>
                <TH colSpan={2} className="text-center">الحركة</TH>
                <TH rowSpan={2}>الرصيد</TH>
              </TR>
              <TR>
                <TH className="text-center">مدين</TH>
                <TH className="text-center">دائن</TH>
              </TR>
            </THead>
            <TBody>
              {entries.length === 0 ? (
                <TR>
                  <TD colSpan={7} className="text-center text-textSecondary py-6">
                    لا توجد حركات في هذه الفترة
                  </TD>
                </TR>
              ) : (
                entries.map((e) => {
                  const href = sourceDocumentHref({ sourceType: e.sourceType, sourceId: e.sourceId, journalEntryId: e.journalEntryId }, locale);
                  return (
                    <TR key={e.id}>
                      <TD>{e.rowNum}</TD>
                      <TD>{new Date(e.date).toLocaleDateString("ar-EG")}</TD>
                      <TD className="font-mono text-xs">
                        {href ? <Link href={href} className="text-blue-600 hover:underline">{e.reference ?? "قيد"}</Link> : (e.reference ?? "—")}
                      </TD>
                      <TD>
                        {href
                          ? <Link href={href} className="text-blue-600 hover:underline">{e.description ?? "—"}</Link>
                          : (e.description ?? "—")}
                        {e.isReversal && <span className="ms-1 rounded bg-amber-100 px-1 text-[10px] text-amber-700">عكس</span>}
                      </TD>
                      <TD className={parseFloat(e.debit) > 0 ? "text-red-600 font-medium text-center" : "text-textSecondary text-center"}>
                        {parseFloat(e.debit) > 0 ? fmt(e.debit) : "—"}
                      </TD>
                      <TD className={parseFloat(e.credit) > 0 ? "text-green-600 font-medium text-center" : "text-textSecondary text-center"}>
                        {parseFloat(e.credit) > 0 ? fmt(e.credit) : "—"}
                      </TD>
                      <TD><BalanceText v={e.balance} /></TD>
                    </TR>
                  );
                })
              )}
            </TBody>
          </Table>
        </div>
      )}

      {/* Create / Edit customer modal */}
      <Modal
        open={custModalOpen}
        onClose={() => setCustModalOpen(false)}
        title={custEditId ? "تعديل بيانات العميل" : "إضافة عميل جديد"}
      >
        <form onSubmit={(e) => void handleSaveCustomer(e)} className="space-y-4" dir="rtl">
          {custError && <Alert variant="error">{custError}</Alert>}

          <div>
            <label className="block text-sm font-medium mb-1">الاسم بالعربي <span className="text-red-500">*</span></label>
            <Input
              value={custNameAr}
              onChange={(e) => setCustNameAr(e.target.value)}
              required
              maxLength={200}
              placeholder="مثال: شركة النيل للتجارة"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">رقم الهاتف (اختياري)</label>
            <Input
              value={custPhone}
              onChange={(e) => setCustPhone(e.target.value)}
              maxLength={30}
              placeholder="مثال: 01012345678"
              dir="ltr"
            />
          </div>

          {custEditId && (
            <div className="flex items-center gap-2">
              <input
                id="custActive"
                type="checkbox"
                checked={custActive}
                onChange={(e) => setCustActive(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <label htmlFor="custActive" className="text-sm">نشط</label>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setCustModalOpen(false)}>إلغاء</Button>
            <Button type="submit" disabled={custSaving || !custNameAr.trim()}>
              {custSaving ? "جار الحفظ..." : custEditId ? "حفظ التعديلات" : "إضافة العميل"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Record transaction modal */}
      <Modal
        open={txModalOpen}
        onClose={() => setTxModalOpen(false)}
        title="تسجيل حركة"
        className="max-w-2xl w-[95vw]"
      >
        <form onSubmit={(e) => void handleCreateTx(e)} className="space-y-4" dir="rtl">
          {txError && <Alert variant="error">{txError}</Alert>}

          <div>
            <label className="block text-sm font-medium mb-1">العميل</label>
            {selectedId ? (
              <div className="px-3 py-2 rounded-md border border-border bg-background text-sm">
                {customers.find((c) => c.id === selectedId)?.code} —{" "}
                {customers.find((c) => c.id === selectedId)?.nameAr}
              </div>
            ) : (
              <select
                className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
                value={txCustomerId}
                onChange={(e) => setTxCustomerId(e.target.value)}
                required
              >
                <option value="">— اختر العميل —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.nameAr}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">النوع</label>
              <select
                className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
                value={txTypeIdx}
                onChange={(e) => setTxTypeIdx(Number(e.target.value))}
              >
                {TX_TYPE_OPTIONS.map((opt, idx) => (
                  <option key={idx} value={idx}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">التاريخ</label>
              <input
                type="date"
                className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
                value={txDate}
                onChange={(e) => setTxDate(e.target.value)}
                required
              />
            </div>
          </div>

          {selectedTxType.direction === null && (
            <div>
              <label className="block text-sm font-medium mb-1">الاتجاه</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="openingDirection"
                    checked={txOpeningDirection === "DR"}
                    onChange={() => setTxOpeningDirection("DR")}
                  />
                  مدين
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="openingDirection"
                    checked={txOpeningDirection === "CR"}
                    onChange={() => setTxOpeningDirection("CR")}
                  />
                  دائن
                </label>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">المبلغ (ج.م)</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={txAmount}
                onChange={(e) => setTxAmount(e.target.value)}
                placeholder="0.00"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">رقم المستند (اختياري)</label>
              <Input
                value={txReference}
                onChange={(e) => setTxReference(e.target.value)}
                placeholder="مثال: INV-001"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">البيان (اختياري)</label>
            <Input
              value={txDescription}
              onChange={(e) => setTxDescription(e.target.value)}
              placeholder="وصف الحركة"
            />
          </div>

          {selectedTxType.value === "RECEIPT" && (
            <div>
              <label className="block text-sm font-medium mb-1">الحساب البنكي</label>
              <select
                className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
                value={txPaymentAccountId}
                onChange={(e) => setTxPaymentAccountId(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setTxModalOpen(false)}>
              إلغاء
            </Button>
            <Button
              type="submit"
              disabled={txSaving || !txAmount || (!selectedId && !txCustomerId)}
            >
              {txSaving ? "جار الحفظ..." : "حفظ"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
