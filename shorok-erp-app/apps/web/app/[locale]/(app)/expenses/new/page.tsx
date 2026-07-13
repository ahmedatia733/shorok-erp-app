"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { BranchPicker } from "../../../../../components/features/inventory/branch-picker";
import { ApiClientError } from "../../../../../lib/api-client";
import { createExpense } from "../../../../../lib/expenses-client";
import { NegativeBalanceModal } from "../../../../../components/features/negative-balance-modal";
import { parseTreasuryWarning, type TreasuryWarning } from "../../../../../lib/treasury-warning";
import { listAccounts, type AccountRow } from "../../../../../lib/accounts-client";

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function autoSelectId(accounts: AccountRow[], ...kws: string[]): string {
  const lower = kws.map((k) => k.toLowerCase());
  return accounts.find(
    (a) => a.isLeaf && a.active && lower.some((k) => a.nameAr.toLowerCase().includes(k) || (a.nameEn ?? "").toLowerCase().includes(k)),
  )?.id ?? "";
}

export default function NewExpensePage() {
  const t       = useTranslations("expenses");
  const tForm   = useTranslations("expenses.form");
  const tCommon = useTranslations("common");
  const locale  = useLocale() as AppLocale;
  const router  = useRouter();
  const params  = useSearchParams();

  const [branchId,           setBranchId]           = useState<string | null>(params.get("branchId"));
  const [date,               setDate]               = useState(todayISO());
  const [description,        setDescription]        = useState("");
  const [amount,             setAmount]             = useState("");
  const [paidFromAccount,    setPaidFromAccount]    = useState("");
  const [glAccountId,        setGlAccountId]        = useState("");
  const [paymentGlAccountId, setPaymentGlAccountId] = useState("");
  const [leafAccounts,       setLeafAccounts]       = useState<AccountRow[]>([]);
  const [submitting,         setSubmitting]         = useState(false);
  const [error,              setError]              = useState<string | null>(null);
  const [success,            setSuccess]            = useState(false);
  const [negWarning,         setNegWarning]         = useState<TreasuryWarning | null>(null);

  useEffect(() => {
    void listAccounts().then((all) => {
      const leaf = all.filter((a) => a.isLeaf && a.active);
      setLeafAccounts(leaf);
      // Auto-select expense account: مصروف / مصاريف / expense
      setGlAccountId(autoSelectId(leaf, "مصروف", "مصاريف", "expense"));
      // Auto-select payment account: نقدية / صندوق / cash / petty
      setPaymentGlAccountId(autoSelectId(leaf, "نقدية", "صندوق", "cash", "petty"));
    });
  }, []);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!branchId || !description.trim() || !amount || !paidFromAccount.trim()) return;
    await submitExpense(false);
  };

  async function submitExpense(acknowledge: boolean) {
    if (!branchId || !description.trim() || !amount || !paidFromAccount.trim()) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await createExpense({
        branchId,
        expenseDate: date,
        description: description.trim(),
        amount: parseFloat(amount).toFixed(2),
        paidFromAccount: paidFromAccount.trim(),
        glAccountId:        glAccountId        || undefined,
        paymentGlAccountId: paymentGlAccountId || undefined,
        ...(acknowledge ? { acknowledgeNegativeBalance: true } : {}),
      });
      setNegWarning(null);
      setSuccess(true);
      setTimeout(() => router.push(`/${locale}/expenses?branchId=${branchId}`), 600);
    } catch (err) {
      const w = parseTreasuryWarning(err);
      if (w) setNegWarning(w); // open the confirmation modal; keep the form
      else if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
      else setError(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("create")}</CardTitle>
        </CardHeader>
        <CardBody>
          {error  && <Alert variant="error"   className="mb-3">{error}</Alert>}
          {success && <Alert variant="success" className="mb-3">{tForm("successCreated")}</Alert>}

          <form onSubmit={onSubmit} className="space-y-4" noValidate dir="rtl">
            <div>
              <BranchPicker value={branchId} onChange={setBranchId} />
            </div>

            <div>
              <Label htmlFor="date">{tForm("date")}</Label>
              <Input
                id="date" type="date" dir="ltr" required
                value={date} onChange={(e) => setDate(e.target.value)} disabled={submitting}
              />
            </div>

            <div>
              <Label htmlFor="description">{tForm("description")}</Label>
              <Input
                id="description" type="text" required maxLength={240}
                placeholder={tForm("descriptionPlaceholder")}
                value={description} onChange={(e) => setDescription(e.target.value)} disabled={submitting}
              />
            </div>

            <div>
              <Label htmlFor="amount">{tForm("amount")}</Label>
              <Input
                id="amount" type="number" step="0.01" dir="ltr" inputMode="decimal" required
                value={amount} onChange={(e) => setAmount(e.target.value)} disabled={submitting}
              />
              <p className="mt-1 text-xs text-textSecondary">{tForm("amountHint")}</p>
            </div>

            <div>
              <Label htmlFor="account">{tForm("paidFromAccount")}</Label>
              <Input
                id="account" type="text" required maxLength={120}
                placeholder={tForm("paidFromAccountPlaceholder")}
                value={paidFromAccount} onChange={(e) => setPaidFromAccount(e.target.value)} disabled={submitting}
              />
            </div>

            {/* GL Accounts section */}
            <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
              <div className="text-xs font-semibold text-textSecondary flex items-center gap-2">
                <span>القيد المحاسبي التلقائي</span>
                <span className="text-textSecondary font-normal">(اختياري — يُسجّل قيد Dr مصروف / Cr حساب دفع)</span>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  حساب المصروف (مدين)
                </label>
                <select
                  value={glAccountId}
                  onChange={(e) => setGlAccountId(e.target.value)}
                  className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
                  disabled={submitting}
                >
                  <option value="">— بدون قيد محاسبي —</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  حساب الدفع (دائن — نقدية/بنك)
                </label>
                <select
                  value={paymentGlAccountId}
                  onChange={(e) => setPaymentGlAccountId(e.target.value)}
                  className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
                  disabled={submitting}
                >
                  <option value="">— بدون قيد محاسبي —</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
                  ))}
                </select>
              </div>

              {glAccountId && paymentGlAccountId && amount && (
                <div className="rounded bg-green-50 border border-green-200 p-2 text-xs font-mono space-y-0.5" dir="rtl">
                  <div className="flex justify-between">
                    <span>مدين — {leafAccounts.find((a) => a.id === glAccountId)?.nameAr}</span>
                    <span dir="ltr">{parseFloat(amount || "0").toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between border-t border-dashed border-green-200 pt-0.5">
                    <span>دائن — {leafAccounts.find((a) => a.id === paymentGlAccountId)?.nameAr}</span>
                    <span dir="ltr">{parseFloat(amount || "0").toFixed(2)}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                {tCommon("back")}
              </Button>
              <Button
                type="submit"
                disabled={submitting || !branchId || !description.trim() || !amount || !paidFromAccount.trim()}
              >
                {submitting ? tForm("submitting") : tForm("submit")}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <NegativeBalanceModal
        warning={negWarning}
        reference={description.trim()}
        submitting={submitting}
        onCancel={() => setNegWarning(null)}
        onConfirm={() => void submitExpense(true)}
      />
    </div>
  );
}
