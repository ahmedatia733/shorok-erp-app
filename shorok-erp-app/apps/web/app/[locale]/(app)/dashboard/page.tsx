"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../i18n";
import { Alert } from "../../../../components/ui/alert";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui/card";
import { EmptyState } from "../../../../components/ui/empty-state";
import { Skeleton } from "../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { BranchPicker } from "../../../../components/features/inventory/branch-picker";
import { getDashboard, type DashboardData } from "../../../../lib/reports-client";
import { formatCurrency, formatNumber } from "../../../../lib/format";
import { useCurrentUser } from "../../../../lib/auth";

export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const locale = useLocale() as AppLocale;
  const user = useCurrentUser();

  // OWNER may opt into the all-branches view (branchId=null). Other roles
  // must pick a specific branch — server enforces this.
  const isOwner = user?.role === "OWNER";
  const [branchId, setBranchId] = useState<string | null>(null);
  const [allBranches, setAllBranches] = useState(isOwner);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    if (!allBranches && !branchId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getDashboard(allBranches ? null : branchId);
        if (!cancelled) setData(res);
      } catch {
        if (!cancelled) setError(t("loadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId, allBranches, t]);

  const ready = data !== null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h1 className="text-xl font-bold">{t("title")}</h1>
        <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center md:gap-4">
          {isOwner ? (
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allBranches}
                onChange={(e) => setAllBranches(e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
              />
              <span>{t("allBranches")}</span>
            </label>
          ) : null}
          {!allBranches ? (
            <BranchPicker value={branchId} onChange={setBranchId} />
          ) : null}
        </div>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label={t("kpis.sales")} value={data?.totalSales} kind="currency" />
        <KpiCard label={t("kpis.collected")} value={data?.totalCollected} kind="currency" />
        <KpiCard
          label={t("kpis.remaining")}
          value={data?.totalRemaining}
          kind="currency"
          accent
        />
        <KpiCard label={t("kpis.expenses")} value={data?.totalExpenses} kind="currency" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("stockSummary")}</CardTitle>
        </CardHeader>
        <CardBody>
          {ready ? (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm text-textSecondary">{t("boardsOnHand")}</div>
                <div className="mt-1 text-lg font-bold" dir="ltr">
                  {formatNumber(data!.stockSummary.boardsOnHand, locale)}
                </div>
              </div>
              <div>
                <div className="text-sm text-textSecondary">{t("metersOnHand")}</div>
                <div className="mt-1 text-lg font-bold" dir="ltr">
                  {formatNumber(data!.stockSummary.metersOnHand, locale)}
                </div>
              </div>
            </div>
          ) : (
            <Skeleton className="h-10" />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("supplierBalances")}</CardTitle>
        </CardHeader>
        <CardBody>
          {!ready ? (
            <Skeleton className="h-10" />
          ) : data!.supplierBalances.length === 0 ? (
            <EmptyState title={t("noSuppliers")} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{t("supplierName")}</TH>
                  <TH>{t("balance")}</TH>
                </TR>
              </THead>
              <TBody>
                {data!.supplierBalances.map((s) => (
                  <TR key={s.supplierId}>
                    <TD className="font-medium">
                      {locale === "ar" ? s.nameAr : s.nameEn}
                    </TD>
                    <TD dir="ltr" className="font-medium">
                      {formatCurrency(s.balance, locale)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("lowStockTitle")}</CardTitle>
        </CardHeader>
        <CardBody>
          {!ready ? (
            <Skeleton className="h-10" />
          ) : data!.lowStock.length === 0 ? (
            <EmptyState title={t("lowStockEmpty")} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{t("product")}</TH>
                  <TH>{t("boardsOnHand")}</TH>
                  <TH>{t("openInventory")}</TH>
                </TR>
              </THead>
              <TBody>
                {data!.lowStock.map((row) => (
                  <TR key={`${row.branchId}-${row.productVariantId}`}>
                    <TD>
                      {locale === "ar" ? row.sku.colorNameAr : row.sku.colorNameEn} ·{" "}
                      <span dir="ltr">
                        {row.sku.code} · {row.sizeMetersPerBoard} m
                      </span>
                    </TD>
                    <TD dir="ltr">{row.boardsOnHand}</TD>
                    <TD>
                      <Link
                        href={`/${locale}/inventory?branchId=${row.branchId}`}
                        className="text-primary hover:underline"
                      >
                        {t("openInventory")}
                      </Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function KpiCard({
  label,
  value,
  kind,
  accent,
}: {
  label: string;
  value: string | undefined;
  kind: "currency" | "number";
  accent?: boolean;
}) {
  const locale = useLocale() as AppLocale;
  return (
    <Card>
      <CardBody>
        <div className="text-sm text-textSecondary">{label}</div>
        <div
          className={`mt-1 text-lg font-bold ${accent ? "text-primary" : ""}`}
          dir="ltr"
        >
          {value === undefined
            ? "…"
            : kind === "currency"
              ? formatCurrency(value, locale)
              : formatNumber(value, locale)}
        </div>
      </CardBody>
    </Card>
  );
}
