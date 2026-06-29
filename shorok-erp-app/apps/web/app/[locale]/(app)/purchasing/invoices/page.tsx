"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody } from "../../../../../components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { useHasRole } from "../../../../../lib/auth";
import {
  listPurchaseInvoices,
  deletePurchaseInvoice,
  type PurchaseInvoiceRow,
} from "../../../../../lib/purchase-invoices-client";
import { formatDate, formatCurrency } from "../../../../../lib/format";

function StatusBadge({ status, t }: { status: string; t: ReturnType<typeof useTranslations> }) {
  const classes: Record<string, string> = {
    DRAFT: "bg-yellow-100 text-yellow-800",
    CONFIRMED: "bg-green-100 text-green-800",
    CANCELLED: "bg-gray-100 text-gray-600",
  };
  const labels: Record<string, string> = {
    DRAFT: t("statusDraft"),
    CONFIRMED: t("statusConfirmed"),
    CANCELLED: t("statusCancelled"),
  };
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${classes[status] ?? ""}`}>
      {labels[status] ?? status}
    </span>
  );
}

export default function PurchaseInvoicesPage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("purchaseInvoices");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const isOwner = useHasRole();
  const canCreate = useHasRole("ACCOUNTANT");

  const [invoices, setInvoices] = useState<PurchaseInvoiceRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const loadInvoices = useCallback(async (cursor?: string | null) => {
    try {
      const page = await listPurchaseInvoices({ limit: 20, cursor });
      if (cursor) {
        setInvoices((prev) => [...prev, ...page.data]);
      } else {
        setInvoices(page.data);
      }
      setNextCursor(page.nextCursor);
    } catch {
      setError(t("loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  async function handleDelete(id: string) {
    try {
      await deletePurchaseInvoice(id);
      setDeleteConfirmId(null);
      setInvoices((prev) => prev.filter((inv) => inv.id !== id));
    } catch {
      setError(tCommon("actionFailed"));
    }
  }

  async function loadMore() {
    setLoadingMore(true);
    await loadInvoices(nextCursor);
    setLoadingMore(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t("title")}</h1>
        {(isOwner || canCreate) && (
          <Button onClick={() => router.push(`/${locale}/purchasing/invoices/new`)}>
            {t("newInvoice")}
          </Button>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <Card>
        <CardBody className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>{t("invoiceNumber")}</TH>
                <TH>{t("invoiceDate")}</TH>
                <TH>{t("supplier")}</TH>
                <TH>{t("branch")}</TH>
                <TH>{t("status")}</TH>
                <TH>{t("grandTotal")}</TH>
                <TH>{tCommon("actions")}</TH>
              </TR>
            </THead>
            <TBody>
              {invoices.length === 0 && (
                <TR>
                  <TD colSpan={7} className="text-center text-textSecondary py-8">
                    {t("empty")}
                  </TD>
                </TR>
              )}
              {invoices.map((inv) => {
                const confirmingDelete = deleteConfirmId === inv.id;
                return (
                  <TR
                    key={inv.id}
                    className="cursor-pointer hover:bg-background"
                    onClick={() => router.push(`/${locale}/purchasing/invoices/${inv.id}`)}
                  >
                    <TD className="font-mono text-sm">{inv.invoiceNumber}</TD>
                    <TD>{formatDate(inv.invoiceDate, locale)}</TD>
                    <TD>{locale === "ar" ? inv.supplierNameAr : inv.supplierNameEn}</TD>
                    <TD>{locale === "ar" ? inv.branchNameAr : inv.branchNameEn}</TD>
                    <TD>
                      <StatusBadge status={inv.status} t={t} />
                    </TD>
                    <TD>{formatCurrency(inv.grandTotal, locale)}</TD>
                    <TD onClick={(e) => e.stopPropagation()}>
                      {isOwner && inv.status === "DRAFT" && (
                        confirmingDelete ? (
                          <div className="flex items-center gap-1 text-sm">
                            <span className="text-xs">{t("deletePrompt")}</span>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => void handleDelete(inv.id)}
                            >
                              {tCommon("yes")}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeleteConfirmId(null)}
                            >
                              {tCommon("no")}
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDeleteConfirmId(inv.id)}
                          >
                            {tCommon("delete")}
                          </Button>
                        )
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      {nextCursor && (
        <div className="text-center">
          <Button variant="ghost" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? tCommon("loading") : tCommon("loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
