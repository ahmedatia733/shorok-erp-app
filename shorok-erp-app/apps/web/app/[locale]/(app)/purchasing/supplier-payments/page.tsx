"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { SupplierPicker } from "../../../../../components/features/factory-ledger/supplier-picker";
import { listAccounts, type AccountRow } from "../../../../../lib/accounts-client";
import { createSupplierPayment, getSupplierStatement, type SupplierStatement } from "../../../../../lib/payments-client";
import { ApiClientError } from "../../../../../lib/api-client";
import { formatDate, formatCurrency } from "../../../../../lib/format";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAllLeafs(accounts: AccountRow[]): AccountRow[] {
  const out: AccountRow[] = [];
  for (const a of accounts) {
    if (a.isLeaf && a.active) out.push(a);
    if (a.children) out.push(...getAllLeafs(a.children));
  }
  return out;
}

function fmt(v: string | number) {
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Account Combobox ──────────────────────────────────────────────────────────

function AccountSelect({
  label,
  hint,
  accounts,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  accounts: AccountRow[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const [search, setSearch] = useState("");
  const visible = search
    ? accounts.filter((a) =>
        (a.code + " " + a.nameAr + " " + (a.nameEn ?? ""))
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
    : accounts;

  const selected = accounts.find((a) => a.id === value);

  return (
    <div className="space-y-1">
      <Label>
        {label}
        {hint && <span className="text-xs text-textSecondary font-normal ms-2">({hint})</span>}
      </Label>
      {selected && (
        <div className="text-xs text-primary bg-primary/5 rounded px-2 py-1 mb-1">
          {selected.code} — {selected.nameAr}
        </div>
      )}
      <Input
        placeholder={`ابحث في الحسابات...`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="border-2 border-primary/40 bg-background"
      />
      <select
        value={value}
        onChange={(e) => { onChange(e.target.value); setSearch(""); }}
        className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
        size={Math.min(visible.length + 1, 6)}
      >
        <option value="">{placeholder ?? "— اختر حساباً —"}</option>
        {visible.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} — {a.nameAr}{a.nameEn ? ` / ${a.nameEn}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Balance Card ──────────────────────────────────────────────────────────────

function SupplierBalanceCard({ supplierId, locale, refreshKey }: { supplierId: string; locale: AppLocale; refreshKey: number }) {
  const [data, setData]       = useState<SupplierStatement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getSupplierStatement(supplierId)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [supplierId, refreshKey]);

  if (loading) return <Skeleton className="h-24" />;
  if (!data) return null;

  const balance = parseFloat(data.closingBalance);
  const totalCredit = parseFloat(data.totalCredit);
  const totalDebit  = parseFloat(data.totalDebit);

  return (
    <Card>
      <CardBody>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-xs text-textSecondary mb-1">إجمالي الفواتير</div>
            <div className="font-bold text-base" dir="ltr">{fmt(totalCredit)}</div>
          </div>
          <div>
            <div className="text-xs text-textSecondary mb-1">إجمالي المدفوع</div>
            <div className="font-bold text-base text-success" dir="ltr">{fmt(totalDebit)}</div>
          </div>
          <div>
            <div className="text-xs text-textSecondary mb-1">الرصيد المستحق</div>
            <div className={`font-bold text-lg ${balance > 0 ? "text-danger" : "text-success"}`} dir="ltr">
              {fmt(balance)}
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ── Payment History ───────────────────────────────────────────────────────────

function PaymentHistory({ supplierId, locale, refreshKey }: { supplierId: string; locale: AppLocale; refreshKey: number }) {
  const [data, setData]       = useState<SupplierStatement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getSupplierStatement(supplierId)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [supplierId, refreshKey]);

  if (loading) return <Skeleton className="h-32" />;
  if (!data || data.entries.length === 0) return (
    <p className="text-sm text-textSecondary py-4 text-center">لا توجد حركات مسجلة لهذا المورد</p>
  );

  return (
    <Table>
      <THead>
        <TR>
          <TH>التاريخ</TH>
          <TH>النوع</TH>
          <TH>المرجع</TH>
          <TH>البيان</TH>
          <TH>مدين</TH>
          <TH>دائن</TH>
          <TH>الرصيد</TH>
        </TR>
      </THead>
      <TBody>
        {data.entries.map((e, i) => (
          <TR key={e.id ?? i}>
            <TD dir="ltr" className="text-xs">{formatDate(e.date, locale)}</TD>
            <TD>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                e.type === "invoice"
                  ? "bg-blue-50 text-blue-700"
                  : "bg-green-50 text-green-700"
              }`}>
                {e.type === "invoice" ? "فاتورة" : "دفعة"}
              </span>
            </TD>
            <TD className="font-mono text-xs">{e.reference}</TD>
            <TD className="text-sm">{e.description}</TD>
            <TD dir="ltr" className={parseFloat(e.debit) > 0 ? "text-success font-medium" : "text-textSecondary text-xs"}>
              {parseFloat(e.debit) > 0 ? fmt(e.debit) : "—"}
            </TD>
            <TD dir="ltr" className={parseFloat(e.credit) > 0 ? "text-danger font-medium" : "text-textSecondary text-xs"}>
              {parseFloat(e.credit) > 0 ? fmt(e.credit) : "—"}
            </TD>
            <TD dir="ltr" className={`font-mono text-xs ${parseFloat(e.balance) > 0 ? "text-danger" : "text-success"}`}>
              {fmt(e.balance)}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SupplierPaymentsPage() {
  const locale = useLocale() as AppLocale;

  const [leafAccounts, setLeafAccounts]   = useState<AccountRow[]>([]);
  const [supplierId, setSupplierId]       = useState<string | null>(null);
  const [apAccountId, setApAccountId]     = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [amount, setAmount]               = useState("");
  const [paymentDate, setPaymentDate]     = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference]         = useState("");
  const [notes, setNotes]                 = useState("");
  const [refreshKey, setRefreshKey]       = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [success, setSuccess]       = useState<{ entryNumber: number } | null>(null);

  useEffect(() => {
    listAccounts().then((rows) => setLeafAccounts(getAllLeafs(rows))).catch(() => {});
  }, []);

  // All liability leaf accounts for AP selection
  const liabilityAccounts = leafAccounts.filter((a) => a.category === "LIABILITY");

  // All asset leaf accounts for bank/cash selection
  const assetAccounts = leafAccounts.filter(
    (a) => a.category === "ASSET" || a.category === "CASH",
  );
  // Also include accounts with "bank/cash" names even if categorized differently
  const bankCashAccounts = assetAccounts.length
    ? assetAccounts
    : leafAccounts.filter((a) => a.category === "ASSET");

  const canSubmit = supplierId && apAccountId && bankAccountId && amount && paymentDate;

  const selectedApAcc   = leafAccounts.find((a) => a.id === apAccountId);
  const selectedBankAcc = leafAccounts.find((a) => a.id === bankAccountId);

  const handleSupplierChange = useCallback((id: string | null) => {
    setSupplierId(id);
    setSuccess(null);
    setError(null);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await createSupplierPayment({
        supplierId: supplierId!,
        apAccountId,
        bankAccountId,
        amount,
        paymentDate,
        reference: reference || undefined,
        notes: notes || undefined,
      });
      setSuccess(result);
      setAmount("");
      setReference("");
      setNotes("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
      else setError("حدث خطأ أثناء تسجيل الدفعة");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold text-textPrimary">دفعات الموردين</h1>
        <div className="flex gap-2">
          <Link href={`/${locale}/purchasing/invoices`}>
            <Button variant="secondary" size="sm">فواتير المشتريات</Button>
          </Link>
          <Link href={`/${locale}/accounting/journal`}>
            <Button variant="secondary" size="sm">القيود اليومية</Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">

        {/* ── Left: Form ─────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>تسجيل دفعة جديدة</CardTitle></CardHeader>
            <CardBody>
              <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">

                {error  && <Alert variant="error">{error}</Alert>}
                {success && (
                  <Alert variant="success">
                    تم تسجيل الدفعة — قيد رقم #{success.entryNumber} ✓
                  </Alert>
                )}

                {/* Supplier */}
                <SupplierPicker value={supplierId} onChange={handleSupplierChange} />

                {/* AP Account — all LIABILITY accounts, user searches */}
                <AccountSelect
                  label="حساب الذمم الدائنة"
                  hint="ابحث بالاسم أو الكود"
                  accounts={liabilityAccounts}
                  value={apAccountId}
                  onChange={setApAccountId}
                  placeholder="— اختر حساب المورد (دائن) —"
                />

                {/* Bank / Cash Account — all ASSET accounts */}
                <AccountSelect
                  label="مصدر الدفع — بنك / خزينة / صندوق"
                  hint="ابحث بالاسم أو الكود"
                  accounts={bankCashAccounts}
                  value={bankAccountId}
                  onChange={setBankAccountId}
                  placeholder="— اختر البنك أو الخزينة —"
                />

                {/* Amount + Date */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="amount">المبلغ (ج.م) *</Label>
                    <Input
                      id="amount"
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="paymentDate">تاريخ الدفعة *</Label>
                    <Input
                      id="paymentDate"
                      type="date"
                      value={paymentDate}
                      onChange={(e) => setPaymentDate(e.target.value)}
                      required
                    />
                  </div>
                </div>

                {/* Reference */}
                <div className="space-y-1">
                  <Label htmlFor="reference">رقم الشيك / التحويل</Label>
                  <Input
                    id="reference"
                    placeholder="CHQ-001234 / TRF-005678"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                  />
                </div>

                {/* Notes */}
                <div className="space-y-1">
                  <Label htmlFor="notes">ملاحظات</Label>
                  <Input
                    id="notes"
                    placeholder="دفعة جزئية — فاتورة رقم ..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>

                {/* GL Preview */}
                {selectedApAcc && selectedBankAcc && amount && parseFloat(amount) > 0 && (
                  <div className="rounded-lg border border-border bg-background p-3 space-y-2 text-sm">
                    <div className="text-xs font-semibold text-textSecondary uppercase tracking-wide">القيد المحاسبي</div>
                    <div className="flex justify-between items-center">
                      <div>
                        <span className="text-xs text-textSecondary me-1">مدين</span>
                        <span>{selectedApAcc.code} — {selectedApAcc.nameAr}</span>
                      </div>
                      <span className="font-mono font-semibold text-success">{fmt(amount)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <div>
                        <span className="text-xs text-textSecondary me-1">دائن</span>
                        <span>{selectedBankAcc.code} — {selectedBankAcc.nameAr}</span>
                      </div>
                      <span className="font-mono font-semibold text-danger">{fmt(amount)}</span>
                    </div>
                  </div>
                )}

                <Button type="submit" disabled={!canSubmit || submitting} className="w-full">
                  {submitting ? "جاري الحفظ..." : "تسجيل الدفعة ←"}
                </Button>
              </form>
            </CardBody>
          </Card>
        </div>

        {/* ── Right: Supplier balance + history ─────────────────────── */}
        <div className="space-y-4">
          {supplierId ? (
            <>
              <SupplierBalanceCard supplierId={supplierId} locale={locale} refreshKey={refreshKey} />

              <Card>
                <CardHeader><CardTitle>سجل الحركات</CardTitle></CardHeader>
                <CardBody>
                  <PaymentHistory supplierId={supplierId} locale={locale} refreshKey={refreshKey} />
                </CardBody>
              </Card>
            </>
          ) : (
            <Card>
              <CardBody>
                <p className="text-sm text-textSecondary text-center py-8">
                  اختر مورداً لعرض رصيده وسجل معاملاته
                </p>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
