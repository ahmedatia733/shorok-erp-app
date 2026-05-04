"use client";

import { useState, type FormEvent } from "react";
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

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function NewExpensePage() {
  const t = useTranslations("expenses");
  const tForm = useTranslations("expenses.form");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const params = useSearchParams();

  const [branchId, setBranchId] = useState<string | null>(params.get("branchId"));
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [paidFromAccount, setPaidFromAccount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!branchId || !description.trim() || !amount || !paidFromAccount.trim()) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await createExpense({
        branchId,
        expenseDate: date,
        description: description.trim(),
        amount: amount.trim(),
        paidFromAccount: paidFromAccount.trim(),
      });
      setSuccess(true);
      setTimeout(() => router.push(`/${locale}/expenses?branchId=${branchId}`), 600);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
      else setError(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("create")}</CardTitle>
        </CardHeader>
        <CardBody>
          {error ? (
            <Alert variant="error" className="mb-3">
              {error}
            </Alert>
          ) : null}
          {success ? (
            <Alert variant="success" className="mb-3">
              {tForm("successCreated")}
            </Alert>
          ) : null}

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div>
              <BranchPicker value={branchId} onChange={setBranchId} />
            </div>

            <div>
              <Label htmlFor="date">{tForm("date")}</Label>
              <Input
                id="date"
                type="date"
                dir="ltr"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div>
              <Label htmlFor="description">{tForm("description")}</Label>
              <Input
                id="description"
                type="text"
                required
                maxLength={240}
                placeholder={tForm("descriptionPlaceholder")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div>
              <Label htmlFor="amount">{tForm("amount")}</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                dir="ltr"
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={submitting}
              />
              <p className="mt-1 text-xs text-textSecondary">{tForm("amountHint")}</p>
            </div>

            <div>
              <Label htmlFor="account">{tForm("paidFromAccount")}</Label>
              <Input
                id="account"
                type="text"
                required
                maxLength={120}
                placeholder={tForm("paidFromAccountPlaceholder")}
                value={paidFromAccount}
                onChange={(e) => setPaidFromAccount(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                {tCommon("back")}
              </Button>
              <Button
                type="submit"
                disabled={
                  submitting ||
                  !branchId ||
                  !description.trim() ||
                  !amount ||
                  !paidFromAccount.trim()
                }
              >
                {submitting ? tForm("submitting") : tForm("submit")}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
