"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { useHasRole } from "../../../../../lib/auth";
import { getIncomeStatement, type IncomeStatementData } from "../../../../../lib/journal-client";
import { formatCurrency } from "../../../../../lib/format";

export default function IncomeStatementPage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("accounting.incomeStatement");
  const router = useRouter();
  const isOwner = useHasRole();

  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 7) + "-01";

  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<IncomeStatementData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOwner) {
      router.replace(`/${locale}/dashboard`);
    }
  }, [isOwner, router, locale]);

  async function handleApply(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await getIncomeStatement(from, to);
      setData(result);
    } catch {
      setError(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  const netProfitNum = data ? parseFloat(data.netProfit) : 0;

  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-xl font-bold">{t("title")}</h1>

      {/* Date range filter */}
      <form onSubmit={(e) => void handleApply(e)} className="flex items-end gap-3">
        <div>
          <label className="block text-sm mb-1">{t("from")}</label>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm mb-1">{t("to")}</label>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={loading}>
          {loading ? "…" : t("apply")}
        </Button>
      </form>

      {error && <Alert variant="error">{error}</Alert>}

      {data && (
        <Card>
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
            <span className="text-sm text-textSecondary">
              {data.from} — {data.to}
            </span>
          </CardHeader>
          <CardBody className="space-y-1 text-sm">
            {/* Revenue */}
            <div className="flex justify-between py-1">
              <span>{t("revenue")}</span>
              <span dir="ltr">{formatCurrency(data.revenue, locale)}</span>
            </div>

            {/* Cost of Sales */}
            <div className="flex justify-between py-1 text-textSecondary">
              <span>{t("costOfSales")}</span>
              <span dir="ltr">({formatCurrency(data.costOfSales, locale)})</span>
            </div>

            <div className="border-t border-border my-2" />

            {/* Gross Profit */}
            <div className="flex justify-between py-1 font-medium">
              <span>{t("grossProfit")}</span>
              <span dir="ltr">{formatCurrency(data.grossProfit, locale)}</span>
            </div>

            {/* Expenses header */}
            {data.expenses.length > 0 && (
              <>
                <div className="pt-2 text-textSecondary font-medium">{t("expenses")}</div>
                {data.expenses.map((exp) => (
                  <div key={exp.accountId} className="flex justify-between py-1 ps-4 text-textSecondary">
                    <span>{locale === "ar" ? exp.nameAr : exp.nameEn}</span>
                    <span dir="ltr">({formatCurrency(exp.amount, locale)})</span>
                  </div>
                ))}
                <div className="flex justify-between py-1 text-textSecondary">
                  <span>{t("totalExpenses")}</span>
                  <span dir="ltr">({formatCurrency(data.totalExpenses, locale)})</span>
                </div>
              </>
            )}

            <div className="border-t border-border my-2" />

            {/* Net Profit */}
            <div
              className={`flex justify-between py-2 font-bold text-base ${
                netProfitNum >= 0 ? "text-success-foreground" : "text-danger-foreground"
              }`}
            >
              <span>{t("netProfit")}</span>
              <span dir="ltr">{formatCurrency(data.netProfit, locale)}</span>
            </div>
          </CardBody>
        </Card>
      )}

      {!data && !loading && !error && (
        <p className="text-textSecondary text-sm">{t("noData")}</p>
      )}
    </div>
  );
}
