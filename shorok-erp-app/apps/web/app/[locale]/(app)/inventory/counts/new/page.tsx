"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Input } from "../../../../../../components/ui/input";
import { EmptyState } from "../../../../../../components/ui/empty-state";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { BranchPicker } from "../../../../../../components/features/inventory/branch-picker";
import { ApiClientError } from "../../../../../../lib/api-client";
import { listBalances, postCount, type BalanceRow } from "../../../../../../lib/inventory-client";
import { formatNumber } from "../../../../../../lib/format";

interface CountedRow extends BalanceRow {
  countedBoards: string;
}

export default function CountsNewPage() {
  const t = useTranslations("inventory.count");
  const tCommon = useTranslations("common");
  const tInv = useTranslations("inventory");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const params = useSearchParams();

  const [branchId, setBranchId] = useState<string | null>(params.get("branchId"));
  const [rows, setRows] = useState<CountedRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!branchId) {
      setRows([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void listBalances(branchId)
      .then((page) => {
        if (!alive) return;
        setRows(page.data.map((r) => ({ ...r, countedBoards: r.boardsOnHand })));
      })
      .catch((err) => {
        if (alive && err instanceof ApiClientError) setError(err.localizedMessage(locale));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [branchId, locale]);

  function variance(row: CountedRow): number {
    const counted = Number(row.countedBoards || "0");
    const expected = Number(row.boardsOnHand);
    return counted - expected;
  }

  function setCounted(idx: number, value: string) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, countedBoards: value } : r)));
  }

  const totalVariance = rows.reduce((sum, r) => sum + Math.abs(variance(r)), 0);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!branchId || rows.length === 0) return;
    if (totalVariance > 0 && !window.confirm(t("varianceWarning"))) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await postCount({
        branchId,
        lines: rows.map((r) => ({
          productVariantId: r.productVariantId,
          countedBoards: r.countedBoards || "0",
        })),
      });
      setSuccess(true);
      setTimeout(() => router.push(`/${locale}/inventory?branchId=${branchId}`), 600);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
      else setError(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-section">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-textSecondary mb-4">{t("subtitle")}</p>
          <div className="mb-4">
            <BranchPicker value={branchId} onChange={setBranchId} />
          </div>

          {error ? (
            <Alert variant="error" className="mb-3">
              {error}
            </Alert>
          ) : null}
          {success ? (
            <Alert variant="success" className="mb-3">
              {t("success")}
            </Alert>
          ) : null}

          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title={tInv("noBalances")} />
          ) : (
            <form onSubmit={onSubmit}>
              <Table>
                <THead>
                  <TR>
                    <TH>{tInv("color")}</TH>
                    <TH>{tInv("code")}</TH>
                    <TH>{tInv("size")}</TH>
                    <TH dir="ltr" className="text-end">
                      {t("expected")}
                    </TH>
                    <TH dir="ltr" className="text-end">
                      {t("counted")}
                    </TH>
                    <TH dir="ltr" className="text-end">
                      {t("variance")}
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row, idx) => {
                    const v = variance(row);
                    const colorClass = v === 0 ? "" : v > 0 ? "text-success" : "text-danger";
                    return (
                      <TR key={row.productVariantId}>
                        <TD>{locale === "ar" ? row.sku.colorNameAr : row.sku.colorNameEn}</TD>
                        <TD dir="ltr">{row.sku.code}</TD>
                        <TD dir="ltr">{row.sizeMetersPerBoard} m</TD>
                        <TD dir="ltr" className="text-end">
                          {formatNumber(row.boardsOnHand, locale)}
                        </TD>
                        <TD dir="ltr" className="text-end">
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            dir="ltr"
                            inputMode="decimal"
                            value={row.countedBoards}
                            onChange={(e) => setCounted(idx, e.target.value)}
                            disabled={submitting}
                            className="w-28 ms-auto"
                          />
                        </TD>
                        <TD dir="ltr" className={`text-end font-medium ${colorClass}`}>
                          {v > 0 ? `+${v}` : v}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>

              <div className="mt-4 flex items-center justify-between gap-3">
                <Button type="button" variant="ghost" onClick={() => router.back()}>
                  {tCommon("back")}
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? t("submitting") : t("submit")}
                </Button>
              </div>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
