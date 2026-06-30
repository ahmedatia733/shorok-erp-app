"use client";

import { useEffect, useState } from "react";
import { Button } from "../../../../../components/ui/button";
import { Alert } from "../../../../../components/ui/alert";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { Modal } from "../../../../../components/ui/modal";
import { Input } from "../../../../../components/ui/input";
import { listSuppliers, type SupplierRow } from "../../../../../lib/suppliers-client";
import {
  listPaymentAccounts,
  getSupplierStatement,
  getAccountStatement,
  createPayment,
  deletePayment,
  type PaymentAccount,
  type SupplierStatement,
  type AccountStatement,
  type StatementEntry,
} from "../../../../../lib/payments-client";

type EntityType = "supplier" | "account";

function fmt(v: string | number) {
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2 });
}

function BalanceCell({ v }: { v: string }) {
  const n = parseFloat(v);
  const color = n > 0 ? "text-red-600" : n < 0 ? "text-green-600" : "text-textSecondary";
  return <TD className={color}>{fmt(v)}</TD>;
}

export default function StatementPage() {
  const [entityType, setEntityType] = useState<EntityType>("supplier");
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SupplierStatement | AccountStatement | null>(null);

  const [payModal, setPayModal] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payAccountId, setPayAccountId] = useState("");
  const [payRef, setPayRef] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [s, a] = await Promise.all([listSuppliers(), listPaymentAccounts()]);
      setSuppliers(s);
      setAccounts(a);
      if (a.length > 0 && a[0]) setPayAccountId(a[0].id);
    })();
  }, []);

  async function load() {
    if (!selectedId) return;
    setLoading(true);
    setError(null);
    try {
      if (entityType === "supplier") {
        setData(await getSupplierStatement(selectedId, from || undefined, to || undefined));
      } else {
        setData(await getAccountStatement(selectedId, from || undefined, to || undefined));
      }
    } catch {
      setError("حدث خطأ أثناء تحميل كشف الحساب");
    } finally {
      setLoading(false);
    }
  }

  async function handlePay() {
    if (!payAmount || !payAccountId || !selectedId) return;
    setSaving(true);
    setSaveError(null);
    try {
      await createPayment({
        entityType: "SUPPLIER",
        entityId: selectedId,
        paymentAccountId: payAccountId,
        amount: payAmount,
        paymentDate: payDate,
        referenceNumber: payRef || undefined,
        notes: payNotes || undefined,
      });
      setPayModal(false);
      setPayAmount("");
      setPayRef("");
      setPayNotes("");
      await load();
    } catch {
      setSaveError("فشل تسجيل الدفعة، تأكد من البيانات");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(paymentId: string) {
    if (!confirm("هل تريد حذف هذه الدفعة؟")) return;
    try {
      await deletePayment(paymentId);
      await load();
    } catch {
      alert("فشل حذف الدفعة");
    }
  }

  const isSupplierData = (d: SupplierStatement | AccountStatement): d is SupplierStatement =>
    "totalDebit" in d;
  const isAccountData = (d: SupplierStatement | AccountStatement): d is AccountStatement =>
    "totalIn" in d;

  const entries: StatementEntry[] = data ? data.entries : [];
  const entityOptions =
    entityType === "supplier"
      ? suppliers.map((s) => ({ id: s.id, label: s.nameAr }))
      : accounts.map((a) => ({ id: a.id, label: a.name }));

  return (
    <div className="space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">كشف الحساب</h1>

      {/* Entity type + selector */}
      <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
        <div className="flex gap-3 flex-wrap">
          {(["supplier", "account"] as EntityType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => { setEntityType(t); setSelectedId(""); setData(null); }}
              className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                entityType === t
                  ? "bg-primary text-white border-primary"
                  : "border-border hover:bg-background"
              }`}
            >
              {t === "supplier" ? "مورد" : "بنك / خزنة"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-textSecondary mb-1">
              {entityType === "supplier" ? "المورد" : "الحساب"}
            </label>
            <select
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              <option value="">— اختر —</option>
              {entityOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
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
          {/* Entity name + summary */}
          <div className="bg-surface border border-border rounded-lg p-4">
            <div className="flex justify-between items-start flex-wrap gap-3">
              <div>
                <div className="font-semibold text-lg">
                  {isSupplierData(data) ? data.entity.nameAr : data.entity.name}
                </div>
                {isSupplierData(data) && data.entity.nameEn && (
                  <div className="text-sm text-textSecondary">{data.entity.nameEn}</div>
                )}
              </div>

              {entityType === "supplier" && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setPayModal(true)}
                >
                  + سداد دفعة
                </Button>
              )}
            </div>

            <div className="mt-3 grid grid-cols-3 gap-4 text-center">
              {isSupplierData(data) && (
                <>
                  <div>
                    <div className="text-xs text-textSecondary">إجمالي المشتريات (دائن)</div>
                    <div className="font-semibold text-red-600">{fmt(data.totalCredit)} ج.م</div>
                  </div>
                  <div>
                    <div className="text-xs text-textSecondary">إجمالي المدفوع (مدين)</div>
                    <div className="font-semibold text-green-600">{fmt(data.totalDebit)} ج.م</div>
                  </div>
                  <div>
                    <div className="text-xs text-textSecondary">الرصيد المستحق</div>
                    <div className={`font-bold text-lg ${parseFloat(data.closingBalance) > 0 ? "text-red-600" : "text-green-600"}`}>
                      {fmt(data.closingBalance)} ج.م
                    </div>
                  </div>
                </>
              )}
              {isAccountData(data) && (
                <>
                  <div>
                    <div className="text-xs text-textSecondary">إجمالي الوارد</div>
                    <div className="font-semibold text-green-600">{fmt(data.totalIn)} ج.م</div>
                  </div>
                  <div>
                    <div className="text-xs text-textSecondary">إجمالي الصادر</div>
                    <div className="font-semibold text-red-600">{fmt(data.totalOut)} ج.م</div>
                  </div>
                  <div>
                    <div className="text-xs text-textSecondary">الرصيد</div>
                    <div className={`font-bold text-lg ${parseFloat(data.closingBalance) >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {fmt(data.closingBalance)} ج.م
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Statement table */}
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <THead>
                <TR>
                  <TH>التاريخ</TH>
                  <TH>المرجع</TH>
                  <TH>البيان</TH>
                  <TH>مدين</TH>
                  <TH>دائن</TH>
                  <TH>الرصيد</TH>
                  {entityType === "supplier" && <TH></TH>}
                </TR>
              </THead>
              <TBody>
                {entries.length === 0 ? (
                  <TR>
                    <TD colSpan={entityType === "supplier" ? 7 : 6} className="text-center text-textSecondary py-6">
                      لا توجد حركات في هذه الفترة
                    </TD>
                  </TR>
                ) : (
                  entries.map((e, i) => (
                    <TR key={i}>
                      <TD>{new Date(e.date).toLocaleDateString("ar-EG")}</TD>
                      <TD className="font-mono text-xs">{e.reference}</TD>
                      <TD>{e.description}</TD>
                      <TD className={parseFloat(e.debit) > 0 ? "text-red-600 font-medium" : "text-textSecondary"}>
                        {parseFloat(e.debit) > 0 ? fmt(e.debit) : "—"}
                      </TD>
                      <TD className={parseFloat(e.credit) > 0 ? "text-green-600 font-medium" : "text-textSecondary"}>
                        {parseFloat(e.credit) > 0 ? fmt(e.credit) : "—"}
                      </TD>
                      <BalanceCell v={e.balance} />
                      {entityType === "supplier" && (
                        <TD>
                          {e.type === "payment" && (
                            <button
                              type="button"
                              onClick={() => void handleDelete(e.id ?? "")}
                              className="text-xs text-red-500 hover:underline"
                            >
                              حذف
                            </button>
                          )}
                        </TD>
                      )}
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </div>
        </div>
      )}

      {/* Pay modal */}
      {payModal && (
        <Modal open={payModal} onClose={() => setPayModal(false)} title="تسجيل دفعة">
          <div className="space-y-4" dir="rtl">
            {saveError && <Alert variant="error">{saveError}</Alert>}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">المبلغ (ج.م)</label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">تاريخ الدفع</label>
                <input
                  type="date"
                  className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">الحساب</label>
              <select
                className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
                value={payAccountId}
                onChange={(e) => setPayAccountId(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">رقم المرجع (اختياري)</label>
              <Input
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
                placeholder="مثال: CHQ-001"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">ملاحظات (اختياري)</label>
              <Input
                value={payNotes}
                onChange={(e) => setPayNotes(e.target.value)}
                placeholder="ملاحظات إضافية"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setPayModal(false)}>إلغاء</Button>
              <Button
                onClick={() => void handlePay()}
                disabled={saving || !payAmount || !payAccountId}
              >
                {saving ? "جار الحفظ..." : "تأكيد الدفعة"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
