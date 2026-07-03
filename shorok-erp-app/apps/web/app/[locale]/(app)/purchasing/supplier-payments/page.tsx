"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { SupplierPicker } from "../../../../../components/features/factory-ledger/supplier-picker";
import { listAccounts, type AccountRow } from "../../../../../lib/accounts-client";
import { createSupplierPayment } from "../../../../../lib/payments-client";
import { ApiClientError } from "../../../../../lib/api-client";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAllLeafs(accounts: AccountRow[]): AccountRow[] {
  const out: AccountRow[] = [];
  for (const a of accounts) {
    if (a.isLeaf && a.active) out.push(a);
    if (a.children) out.push(...getAllLeafs(a.children));
  }
  return out;
}

function AccountSelect({
  label,
  accounts,
  value,
  onChange,
  placeholder,
}: {
  label: string;
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

  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        placeholder={`بحث في ${label}...`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-1 border-2 border-primary/40 bg-background"
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <option value="">{placeholder ?? "— اختر حساباً —"}</option>
        {visible.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} — {a.nameAr}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SupplierPaymentsPage() {
  const locale = useLocale() as AppLocale;

  const [allAccounts, setAllAccounts] = useState<AccountRow[]>([]);
  const [supplierId, setSupplierId]   = useState<string | null>(null);
  const [apAccountId, setApAccountId] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [amount, setAmount]           = useState("");
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference]     = useState("");
  const [notes, setNotes]             = useState("");

  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [success, setSuccess]         = useState<{ entryNumber: number; journalEntryId: string } | null>(null);

  useEffect(() => {
    listAccounts().then((rows) => {
      setAllAccounts(rows);
    }).catch(() => {});
  }, []);

  const leafAccounts = getAllLeafs(allAccounts);

  // AP accounts = LIABILITY category containing supplier/payable keywords
  const apAccounts = leafAccounts.filter((a) =>
    a.category === "LIABILITY" &&
    /دائن|مورد|ذمم|payabl|مستحق|accrued/i.test((a.nameAr + " " + (a.nameEn ?? "")).toLowerCase()),
  );

  // Bank accounts = ASSET category containing bank keywords
  const bankAccounts = leafAccounts.filter((a) =>
    a.category === "ASSET" &&
    /بنك|مصرف|bank|cib|nbe|qnb|hsbc|abc|خزن|خزينة|صندوق|نقد|كاش|cash/i.test(
      (a.nameAr + " " + (a.nameEn ?? "")).toLowerCase(),
    ),
  );

  const canSubmit = supplierId && apAccountId && bankAccountId && amount && paymentDate;

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
      // Reset form
      setAmount("");
      setReference("");
      setNotes("");
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
      else setError("حدث خطأ أثناء تسجيل الدفعة");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-textPrimary">تسجيل دفعة للمورد</h1>
        <Link href={`/${locale}/purchasing/invoices`}>
          <Button variant="secondary" size="sm">← العودة للفواتير</Button>
        </Link>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {success && (
        <Alert variant="success">
          <div className="flex items-center justify-between">
            <span>تم تسجيل الدفعة بنجاح — قيد رقم #{success.entryNumber}</span>
            <Link href={`/${locale}/accounting/journal`}>
              <Button size="sm" variant="secondary">عرض في القيود</Button>
            </Link>
          </div>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>بيانات الدفعة</CardTitle>
        </CardHeader>
        <CardBody>
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">

            {/* Supplier */}
            <div className="space-y-1">
              <SupplierPicker value={supplierId} onChange={setSupplierId} />
            </div>

            {/* AP Account */}
            <AccountSelect
              label="حساب الذمم الدائنة (المورد)"
              accounts={apAccounts.length ? apAccounts : leafAccounts.filter((a) => a.category === "LIABILITY")}
              value={apAccountId}
              onChange={setApAccountId}
              placeholder="— اختر حساب الذمم الدائنة —"
            />

            {/* Bank Account */}
            <AccountSelect
              label="حساب البنك / الخزينة (المصدر)"
              accounts={bankAccounts.length ? bankAccounts : leafAccounts.filter((a) => a.category === "ASSET")}
              value={bankAccountId}
              onChange={setBankAccountId}
              placeholder="— اختر حساب البنك أو الخزينة —"
            />

            {/* Amount + Date */}
            <div className="grid grid-cols-2 gap-4">
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
              <Label htmlFor="reference">رقم الشيك / التحويل (اختياري)</Label>
              <Input
                id="reference"
                placeholder="مثال: CHQ-001234"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>

            {/* Notes */}
            <div className="space-y-1">
              <Label htmlFor="notes">ملاحظات (اختياري)</Label>
              <Input
                id="notes"
                placeholder="دفعة جزئية / سداد كامل / ..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {/* GL Preview */}
            {apAccountId && bankAccountId && amount && (
              <div className="rounded-md border border-border bg-background p-3 text-sm space-y-1">
                <div className="font-medium text-textSecondary text-xs mb-2">القيد المحاسبي المقترح</div>
                <div className="flex justify-between">
                  <span className="text-textPrimary">
                    مدين — {leafAccounts.find((a) => a.id === apAccountId)?.nameAr ?? "حساب AP"}
                  </span>
                  <span className="font-mono text-success font-semibold">{parseFloat(amount || "0").toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-textPrimary">
                    دائن — {leafAccounts.find((a) => a.id === bankAccountId)?.nameAr ?? "حساب البنك"}
                  </span>
                  <span className="font-mono text-red-600 font-semibold">{parseFloat(amount || "0").toFixed(2)}</span>
                </div>
              </div>
            )}

            <Button type="submit" disabled={!canSubmit || submitting} className="w-full">
              {submitting ? "جاري الحفظ..." : "تسجيل الدفعة"}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
