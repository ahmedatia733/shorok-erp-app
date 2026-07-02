"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../i18n";
import { Alert } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { ApiClientError } from "../../../lib/api-client";
import { recordCollection } from "../../../lib/orders-client";
import { listAccounts, type AccountRow } from "../../../lib/accounts-client";
import { decimalSub } from "../../../lib/decimal-string";

function autoSelectId(accounts: AccountRow[], ...kws: string[]): string {
  const lower = kws.map((k) => k.toLowerCase());
  return accounts.find(
    (a) => a.isLeaf && a.active && lower.some((k) => a.nameAr.toLowerCase().includes(k) || (a.nameEn ?? "").toLowerCase().includes(k)),
  )?.id ?? "";
}

interface Props {
  orderId: string;
  /** Decimal-string remaining amount on the order (server-authoritative). */
  remainingAmount: string;
  isOpen: boolean;
  onClose: () => void;
  onRecorded: () => void;
}

/**
 * Collection drawer per `docs/ui-design/outputs/orders/design.md` ("Collection
 * modal"). Validates client-side that the entered amount cannot exceed
 * `remainingAmount` using decimal-string math (no float drift). The server
 * is authoritative — the API rejects with `collection_exceeds_required`
 * regardless of what the client allows.
 */
export function CollectionDrawer({
  orderId,
  remainingAmount,
  isOpen,
  onClose,
  onRecorded,
}: Props) {
  const t = useTranslations("orders.collection");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const locale = useLocale() as AppLocale;
  const [amount, setAmount] = useState("");
  const [paidToAccount, setPaidToAccount] = useState("");
  const [leafAccounts, setLeafAccounts] = useState<AccountRow[]>([]);
  const [cashAccountId, setCashAccountId] = useState("");
  const [arAccountId, setArAccountId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    void listAccounts().then((all) => {
      const leaf = all.filter((a) => a.isLeaf && a.active);
      setLeafAccounts(leaf);
      setCashAccountId(autoSelectId(leaf, "نقدية", "صندوق", "cash", "petty"));
      setArAccountId(autoSelectId(leaf, "ذمم مدينة", "عملاء", "receivable", "ar"));
    });
  }, [isOpen]);

  if (!isOpen) return null;

  const exceedsRemaining = (() => {
    if (!amount) return false;
    const after = decimalSub(amount, remainingAmount);
    if (after === null) return false;
    return !after.startsWith("-") && after !== "0.0000";
  })();

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (exceedsRemaining) return;
    setSubmitting(true);
    setError(null);
    try {
      await recordCollection(orderId, {
        amount,
        paidToAccount:  paidToAccount.trim() || undefined,
        cashAccountId:  cashAccountId  || undefined,
        arAccountId:    arAccountId    || undefined,
      });
      setAmount("");
      setPaidToAccount("");
      onRecorded();
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
      else setError(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("title")}
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/40"
      onClick={onClose}
    >
      <aside
        className="w-full max-w-md bg-surface p-6 shadow-lg overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-section-title mb-4">{t("title")}</h2>

        {error ? (
          <Alert variant="error" className="mb-3">
            {error}
          </Alert>
        ) : null}
        {exceedsRemaining ? (
          <Alert variant="warning" className="mb-3">
            {tErrors("validation_failed")}
          </Alert>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="collection-amount">{t("amount")}</Label>
            <Input
              id="collection-amount"
              type="number"
              step="0.01"
              min="0.01"
              dir="ltr"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div>
            <Label htmlFor="paid-to-account">{t("paidToAccount")}</Label>
            <Input
              id="paid-to-account"
              type="text"
              maxLength={120}
              value={paidToAccount}
              onChange={(e) => setPaidToAccount(e.target.value)}
              disabled={submitting}
            />
          </div>

          {/* GL journal entry — optional */}
          <div className="rounded-lg border border-border bg-surface p-3 space-y-3">
            <p className="text-xs font-semibold text-textSecondary">
              القيد المحاسبي التلقائي <span className="font-normal">(اختياري)</span>
            </p>
            <div>
              <label className="block text-sm font-medium mb-1">حساب النقدية/البنك (مدين)</label>
              <select
                value={cashAccountId}
                onChange={(e) => setCashAccountId(e.target.value)}
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
              <label className="block text-sm font-medium mb-1">حساب العملاء / الذمم المدينة (دائن)</label>
              <select
                value={arAccountId}
                onChange={(e) => setArAccountId(e.target.value)}
                className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
                disabled={submitting}
              >
                <option value="">— بدون قيد محاسبي —</option>
                {leafAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
                ))}
              </select>
            </div>
            {cashAccountId && arAccountId && amount && (
              <div className="rounded bg-green-50 border border-green-200 p-2 text-xs font-mono space-y-0.5" dir="rtl">
                <div className="flex justify-between">
                  <span>مدين — {leafAccounts.find((a) => a.id === cashAccountId)?.nameAr}</span>
                  <span dir="ltr">{parseFloat(amount || "0").toFixed(2)}</span>
                </div>
                <div className="flex justify-between border-t border-dashed border-green-200 pt-0.5">
                  <span>دائن — {leafAccounts.find((a) => a.id === arAccountId)?.nameAr}</span>
                  <span dir="ltr">{parseFloat(amount || "0").toFixed(2)}</span>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={submitting || !amount || exceedsRemaining}>
              {submitting ? t("submitting") : t("submit")}
            </Button>
          </div>
        </form>
      </aside>
    </div>
  );
}
