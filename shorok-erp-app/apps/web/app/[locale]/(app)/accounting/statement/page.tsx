"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Button } from "../../../../../components/ui/button";
import { Alert } from "../../../../../components/ui/alert";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { Modal } from "../../../../../components/ui/modal";
import { Input } from "../../../../../components/ui/input";
import { listSuppliers, type SupplierRow } from "../../../../../lib/suppliers-client";
import { listAccounts, type AccountRow } from "../../../../../lib/accounts-client";
import {
  listPaymentAccounts,
  getSupplierStatement,
  getAccountStatement,
  createPayment,
  type PaymentAccount,
  type SupplierStatement,
  type AccountStatement,
  type StatementEntry,
} from "../../../../../lib/payments-client";

// ── helpers ───────────────────────────────────────────────────────────────────

type EntityType = "supplier" | "account" | "gl_account";

function fmt(v: string | number) {
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2 });
}

function BalanceCell({ v }: { v: string }) {
  const n = parseFloat(v);
  const color = n > 0 ? "text-red-600" : n < 0 ? "text-green-600" : "text-textSecondary";
  return <TD className={color}>{fmt(v)}</TD>;
}

function getAllLeafs(accounts: AccountRow[]): AccountRow[] {
  const out: AccountRow[] = [];
  for (const a of accounts) {
    if (a.isLeaf && a.active) out.push(a);
    if (a.children) out.push(...getAllLeafs(a.children));
  }
  return out;
}

// ── Source document badge ─────────────────────────────────────────────────────

const SOURCE_MAP: Record<string, { label: string; href: (id: string, loc: string) => string }> = {
  sales_invoice:          { label: "فاتورة مبيعات",  href: (id, l) => `/${l}/sales/invoices/${id}` },
  order_collection:       { label: "تحصيل طلبية",   href: (id, l) => `/${l}/orders` },
  purchase_invoice:       { label: "فاتورة مشتريات", href: (id, l) => `/${l}/purchasing/invoices` },
  factory_ledger_payment: { label: "دفعة مصنع",     href: (id, l) => `/${l}/factory-orders` },
  expense:                { label: "مصروف",           href: (id, l) => `/${l}/expenses` },
  depreciation_entry:     { label: "استهلاك أصل",   href: (id, l) => `/${l}/accounting/fixed-assets` },
  fixed_asset:            { label: "أصل ثابت",      href: (id, l) => `/${l}/accounting/fixed-assets` },
};

function SourceBadge({
  refType,
  refId,
  locale,
}: {
  refType?: string;
  refId?: string;
  locale: AppLocale;
}) {
  if (!refType) return <span className="text-textSecondary text-xs">يدوي</span>;
  const def = SOURCE_MAP[refType];
  if (!def) return <span className="text-xs font-mono text-textSecondary">{refType}</span>;
  if (!refId) {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-700">
        {def.label}
      </span>
    );
  }
  return (
    <a
      href={def.href(refId, locale)}
      className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
    >
      {def.label} ↗
    </a>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function StatementPage() {
  const locale = useLocale() as AppLocale;
  const [entityType, setEntityType] = useState<EntityType>("supplier");
  const [suppliers,  setSuppliers]  = useState<SupplierRow[]>([]);
  const [accounts,   setAccounts]   = useState<PaymentAccount[]>([]);
  const [glAccounts, setGlAccounts] = useState<AccountRow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [from, setFrom] = useState("");
  const [to,   setTo]   = useState("");

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [data,    setData]    = useState<SupplierStatement | AccountStatement | null>(null);

  // Pay modal
  const [payModal,    setPayModal]    = useState(false);
  const [payAmount,   setPayAmount]   = useState("");
  const [payAccountId,setPayAccountId]= useState("");
  const [payRef,      setPayRef]      = useState("");
  const [payNotes,    setPayNotes]    = useState("");
  const [payDate,     setPayDate]     = useState(new Date().toISOString().slice(0, 10));
  const [saving,      setSaving]      = useState(false);
  const [saveError,   setSaveError]   = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [s, a, accs] = await Promise.all([listSuppliers(), listPaymentAccounts(), listAccounts()]);
      setSuppliers(s);
      setAccounts(a);
      setGlAccounts(getAllLeafs(accs));
      if (a.length > 0 && a[0]) setPayAccountId(a[0].id);
    })();
  }, []);

  // Deep-link from income statement / journal entry
  useEffect(() => {
    const accountId = new URLSearchParams(window.location.search).get("accountId") ?? "";
    if (accountId) {
      setEntityType("gl_account");
      setSelectedId(accountId);
      void load(accountId, "gl_account");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(idOverride?: string, typeOverride?: EntityType) {
    const id   = idOverride ?? selectedId;
    const type = typeOverride ?? entityType;
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      if (type === "supplier") {
        setData(await getSupplierStatement(id, from || undefined, to || undefined));
      } else {
        // Both "account" (PaymentAccount) and "gl_account" use getAccountStatement
        setData(await getAccountStatement(id, from || undefined, to || undefined));
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
        entityType:     "SUPPLIER",
        entityId:       selectedId,
        paymentAccountId: payAccountId,
        amount:         payAmount,
        paymentDate:    payDate,
        referenceNumber: payRef || undefined,
        notes:          payNotes || undefined,
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

  function switchType(t: EntityType) {
    setEntityType(t);
    setSelectedId("");
    setData(null);
  }

  const isSupplierData = (d: SupplierStatement | AccountStatement): d is SupplierStatement =>
    "totalDebit" in d;
  const isAccountData = (d: SupplierStatement | AccountStatement): d is AccountStatement =>
    "totalIn" in d;

  const isGLAccount = isAccountData(data!) && (data as AccountStatement)?.entity?.type === "gl_account";

  const entries: StatementEntry[] = data ? data.entries : [];

  const entityOptions =
    entityType === "supplier"
      ? suppliers.map((s) => ({ id: s.id, label: s.nameAr }))
      : entityType === "account"
      ? accounts.map((a) => ({ id: a.id, label: a.name }))
      : glAccounts.map((a) => ({ id: a.id, label: `${a.code} — ${a.nameAr}` }));

  const tabCls = (t: EntityType) =>
    `px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
      entityType === t
        ? "bg-primary text-white border-primary"
        : "border-border hover:bg-background text-textSecondary"
    }`;

  // For GL account, show running balance column direction hint
  const glDebitNet = data && isAccountData(data) ? parseFloat(data.totalIn) - parseFloat(data.totalOut) : 0;

  return (
    <div className="space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">كشف الحساب</h1>

      {/* Entity type tabs */}
      <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
        <div className="flex gap-2 flex-wrap">
          <button type="button" className={tabCls("supplier")}  onClick={() => switchType("supplier")}>مورد</button>
          <button type="button" className={tabCls("account")}   onClick={() => switchType("account")}>بنك / خزنة</button>
          <button type="button" className={tabCls("gl_account")} onClick={() => switchType("gl_account")}>حساب محاسبي</button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className={entityType === "gl_account" ? "md:col-span-2" : ""}>
            <label className="block text-xs text-textSecondary mb-1">
              {entityType === "supplier" ? "المورد" : entityType === "account" ? "الحساب (بنك/خزنة)" : "الحساب المحاسبي"}
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
            <Button
              onClick={() => void load(undefined, undefined)}
              disabled={!selectedId || loading}
              className="w-full"
            >
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
                {isAccountData(data) && data.entity.code && (
                  <div className="text-xs font-mono text-textSecondary">{data.entity.code}</div>
                )}
              </div>

              {/* Phase-1 hotfix T004: this button wrote to the legacy Payment
                  model which creates NO journal entry (invisible in GL).
                  Frozen pending migration — supplier payments go through
                  دفعات الموردين which posts a real GL entry. */}
              {entityType === "supplier" && (
                <a href={`/${locale}/purchasing/supplier-payments`}>
                  <Button variant="primary" size="sm">+ سداد دفعة (من صفحة دفعات الموردين)</Button>
                </a>
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
                    <div className="text-xs text-textSecondary">
                      {isGLAccount ? "إجمالي المدين" : "إجمالي الوارد"}
                    </div>
                    <div className="font-semibold text-red-700">{fmt(data.totalIn)} ج.م</div>
                  </div>
                  <div>
                    <div className="text-xs text-textSecondary">
                      {isGLAccount ? "إجمالي الدائن" : "إجمالي الصادر"}
                    </div>
                    <div className="font-semibold text-green-700">{fmt(data.totalOut)} ج.م</div>
                  </div>
                  <div>
                    <div className="text-xs text-textSecondary">الرصيد (مدين − دائن)</div>
                    <div className={`font-bold text-lg ${glDebitNet >= 0 ? "text-red-700" : "text-green-700"}`}>
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
                  {isGLAccount && <TH>مصدر القيد</TH>}
                  <TH className="text-end font-bold text-red-700">مدين</TH>
                  <TH className="text-end font-bold text-green-700">دائن</TH>
                  <TH className="text-end">الرصيد</TH>
                  {entityType === "supplier" && <TH />}
                </TR>
              </THead>
              <TBody>
                {entries.length === 0 ? (
                  <TR>
                    <TD colSpan={isGLAccount ? 7 : entityType === "supplier" ? 7 : 6} className="text-center text-textSecondary py-6">
                      لا توجد حركات في هذه الفترة
                    </TD>
                  </TR>
                ) : (
                  entries.map((e, i) => (
                    <TR key={i}>
                      <TD className="text-sm whitespace-nowrap">
                        {new Date(e.date).toLocaleDateString("ar-EG")}
                      </TD>
                      <TD className="font-mono text-xs">
                        {e.journalEntryId ? (
                          <a
                            href={`/${locale}/accounting/journal`}
                            className="text-blue-700 hover:underline"
                            title="الانتقال إلى القيود اليومية"
                          >
                            {e.reference}
                          </a>
                        ) : (
                          e.reference
                        )}
                      </TD>
                      <TD className="text-sm">{e.description}</TD>
                      {isGLAccount && (
                        <TD>
                          <SourceBadge refType={e.referenceType} refId={e.referenceId} locale={locale} />
                        </TD>
                      )}
                      <TD className={`text-end tabular-nums ${parseFloat(e.debit) > 0 ? "bg-red-50 text-red-700 font-medium" : "text-textSecondary"}`}>
                        {parseFloat(e.debit) > 0 ? fmt(e.debit) : "—"}
                      </TD>
                      <TD className={`text-end tabular-nums ${parseFloat(e.credit) > 0 ? "bg-green-50 text-green-700 font-medium" : "text-textSecondary"}`}>
                        {parseFloat(e.credit) > 0 ? fmt(e.credit) : "—"}
                      </TD>
                      <BalanceCell v={e.balance} />
                      {/* Phase-1 hotfix T004: legacy payment delete frozen —
                          history is read-only pending migration. */}
                      {entityType === "supplier" && <TD />}
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
