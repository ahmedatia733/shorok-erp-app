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
import { SupplierPicker } from "../../../../../components/features/factory-ledger/supplier-picker";
import { VariantPicker } from "../../../../../components/features/inventory/variant-picker";
import { ApiClientError } from "../../../../../lib/api-client";
import {
  createFactoryEntry,
  createFactoryPayment,
} from "../../../../../lib/factory-ledger-client";
import { listAccounts, type AccountRow } from "../../../../../lib/accounts-client";

function autoSelectId(accounts: AccountRow[], ...kws: string[]): string {
  const lower = kws.map((k) => k.toLowerCase());
  return accounts.find(
    (a) => a.isLeaf && a.active && lower.some((k) => a.nameAr.toLowerCase().includes(k) || (a.nameEn ?? "").toLowerCase().includes(k)),
  )?.id ?? "";
}

type Tab = "purchase" | "payment";

/** Phase-1 hotfix T004: factory-ledger writes frozen pending migration
 *  to purchase invoices + payment vouchers (specs/elshrouq-erp-redesign). */
const LEGACY_WRITES_FROZEN = true;

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function NewFactoryEntryPage() {
  const t = useTranslations("factory_orders");
  const tForm = useTranslations("factory_orders.form");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const params = useSearchParams();

  const [tab, setTab] = useState<Tab>("purchase");
  const [supplierId, setSupplierId] = useState<string | null>(params.get("supplierId"));
  const [orderDate, setOrderDate] = useState(todayISO());
  const [variantId, setVariantId] = useState<string | null>(null);
  const [boards, setBoards] = useState("");
  const [pricePerMeter, setPricePerMeter] = useState("");
  const [paidAmount, setPaidAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [leafAccounts, setLeafAccounts] = useState<AccountRow[]>([]);
  const [debitAccountId, setDebitAccountId] = useState("");
  const [creditAccountId, setCreditAccountId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listAccounts().then((all) => {
      const leaf = all.filter((a) => a.isLeaf && a.active);
      setLeafAccounts(leaf);
      setDebitAccountId(autoSelectId(leaf, "موردون", "دائنون", "supplier", "payable", "ap"));
      setCreditAccountId(autoSelectId(leaf, "نقدية", "صندوق", "cash", "petty"));
    });
  }, []);

  const purchaseReady =
    !!supplierId &&
    !!variantId &&
    boards.trim() !== "" &&
    pricePerMeter.trim() !== "" &&
    paidAmount.trim() !== "";
  const paymentReady = !!supplierId && paidAmount.trim() !== "";

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!supplierId) return;
    setSubmitting(true);
    setError(null);
    try {
      if (tab === "purchase") {
        if (!variantId) return;
        await createFactoryEntry({
          supplierId,
          orderDate,
          productVariantId: variantId,
          boardsQuantity: boards.trim(),
          purchasePricePerMeter: pricePerMeter.trim(),
          paidAmount: paidAmount.trim(),
          notes: notes.trim() || undefined,
        });
      } else {
        await createFactoryPayment({
          supplierId,
          orderDate,
          paidAmount: paidAmount.trim(),
          notes: notes.trim() || undefined,
          debitAccountId:  debitAccountId  || undefined,
          creditAccountId: creditAccountId || undefined,
        });
      }
      router.push(`/${locale}/factory-orders?supplierId=${supplierId}`);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
      else setError(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl">
      {/* Phase-1 hotfix T004 (specs/elshrouq-erp-redesign): factory ledger is a
          legacy parallel ledger being migrated to purchase invoices + payment
          vouchers; new writes are frozen so migration reconciliation stays clean. */}
      <Alert variant="warning" className="mb-4">
        هذه الشاشة قيد الاستبدال ضمن تطوير النظام المحاسبي، وتسجيل حركات جديدة هنا متوقف.
        لتسجيل المشتريات الجديدة استخدم{" "}
        <a href={`/${locale}/purchasing/invoices/new`} className="underline font-medium">
          فواتير المشتريات
        </a>
        .
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>{t("create")}</CardTitle>
        </CardHeader>
        <CardBody>
          <div
            role="tablist"
            aria-label={t("kindLabel")}
            className="mb-4 flex gap-2 border-b border-border"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === "purchase"}
              onClick={() => setTab("purchase")}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === "purchase"
                  ? "border-primary text-primary"
                  : "border-transparent text-textSecondary hover:text-textPrimary"
              }`}
            >
              {t("kinds.purchase")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "payment"}
              onClick={() => setTab("payment")}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === "payment"
                  ? "border-primary text-primary"
                  : "border-transparent text-textSecondary hover:text-textPrimary"
              }`}
            >
              {t("kinds.payment")}
            </button>
          </div>

          {error ? (
            <Alert variant="error" className="mb-3">
              {error}
            </Alert>
          ) : null}

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <SupplierPicker value={supplierId} onChange={setSupplierId} disabled={submitting} />

            <div>
              <Label htmlFor="orderDate">{tForm("orderDate")}</Label>
              <Input
                id="orderDate"
                type="date"
                dir="ltr"
                required
                value={orderDate}
                onChange={(e) => setOrderDate(e.target.value)}
                disabled={submitting}
              />
            </div>

            {tab === "purchase" ? (
              <>
                <div>
                  <Label htmlFor="variant">{tForm("variant")}</Label>
                  <VariantPicker
                    id="variant"
                    value={variantId}
                    onChange={setVariantId}
                    required
                    disabled={submitting}
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <Label htmlFor="boards">{tForm("boardsQuantity")}</Label>
                    <Input
                      id="boards"
                      type="number"
                      step="0.01"
                      min="0.0001"
                      dir="ltr"
                      inputMode="decimal"
                      required
                      value={boards}
                      onChange={(e) => setBoards(e.target.value)}
                      disabled={submitting}
                    />
                  </div>
                  <div>
                    <Label htmlFor="price">{tForm("purchasePricePerMeter")}</Label>
                    <Input
                      id="price"
                      type="number"
                      step="0.01"
                      min="0.01"
                      dir="ltr"
                      inputMode="decimal"
                      required
                      value={pricePerMeter}
                      onChange={(e) => setPricePerMeter(e.target.value)}
                      disabled={submitting}
                    />
                  </div>
                </div>
              </>
            ) : null}

            <div>
              <Label htmlFor="paid">
                {tab === "purchase" ? tForm("paidAmountPurchase") : tForm("paidAmountPayment")}
              </Label>
              <Input
                id="paid"
                type="number"
                step="0.01"
                min={tab === "purchase" ? "0" : "0.01"}
                dir="ltr"
                inputMode="decimal"
                required
                value={paidAmount}
                onChange={(e) => setPaidAmount(e.target.value)}
                disabled={submitting}
              />
              <p className="mt-1 text-xs text-textSecondary">
                {tab === "purchase" ? tForm("paidHintPurchase") : tForm("paidHintPayment")}
              </p>
            </div>

            <div>
              <Label htmlFor="notes">{tForm("notes")}</Label>
              <Input
                id="notes"
                type="text"
                maxLength={2000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={submitting}
              />
            </div>

            {/* GL journal entry for payments only */}
            {tab === "payment" && (
              <div className="rounded-lg border border-border bg-surface p-3 space-y-3">
                <p className="text-xs font-semibold text-textSecondary">
                  القيد المحاسبي التلقائي <span className="font-normal">(اختياري)</span>
                </p>
                <div>
                  <label className="block text-sm font-medium mb-1">حساب الموردون / الذمم الدائنة (مدين)</label>
                  <select
                    value={debitAccountId}
                    onChange={(e) => setDebitAccountId(e.target.value)}
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
                  <label className="block text-sm font-medium mb-1">حساب النقدية / البنك (دائن)</label>
                  <select
                    value={creditAccountId}
                    onChange={(e) => setCreditAccountId(e.target.value)}
                    className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
                    disabled={submitting}
                  >
                    <option value="">— بدون قيد محاسبي —</option>
                    {leafAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
                    ))}
                  </select>
                </div>
                {debitAccountId && creditAccountId && paidAmount && (
                  <div className="rounded bg-blue-50 border border-blue-200 p-2 text-xs font-mono space-y-0.5" dir="rtl">
                    <div className="flex justify-between">
                      <span>مدين — {leafAccounts.find((a) => a.id === debitAccountId)?.nameAr}</span>
                      <span dir="ltr">{parseFloat(paidAmount || "0").toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-t border-dashed border-blue-200 pt-0.5">
                      <span>دائن — {leafAccounts.find((a) => a.id === creditAccountId)?.nameAr}</span>
                      <span dir="ltr">{parseFloat(paidAmount || "0").toFixed(2)}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-2">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                {tCommon("back")}
              </Button>
              <Button
                type="submit"
                disabled={
                  LEGACY_WRITES_FROZEN ||
                  submitting ||
                  (tab === "purchase" ? !purchaseReady : !paymentReady)
                }
                title="تسجيل حركات دفتر المصنع متوقف — استخدم فواتير المشتريات"
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
