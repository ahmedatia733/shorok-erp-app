"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody } from "../../../../../../components/ui/card";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import { useHasRole } from "../../../../../../lib/auth";
import { ApiClientError } from "../../../../../../lib/api-client";
import {
  getRepresentative,
  updateRepresentative,
  type SalesRepresentative,
  type SalesRepresentativeDetail,
} from "../../../../../../lib/sales-representatives-client";
import { RepresentativeFormModal } from "../../../../../../components/sales-representatives/representative-form-modal";

function fmt(v: string | number) {
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardBody className="text-center">
        <div className="text-xs text-textSecondary mb-1">{label}</div>
        <div className="font-bold text-lg">{value}</div>
      </CardBody>
    </Card>
  );
}

export default function RepresentativeDetailsPage() {
  const t = useTranslations("salesReps");
  const locale = useLocale() as AppLocale;
  const params = useParams();
  const id = params.id as string;
  const canManage = useHasRole("ACCOUNTANT");

  const [rep, setRep] = useState<SalesRepresentativeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRep(await getRepresentative(id));
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [id, locale, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleActive() {
    if (!rep) return;
    await updateRepresentative(rep.id, { active: !rep.active });
    await load();
  }

  function onSaved(_saved: SalesRepresentative) {
    setEditOpen(false);
    void load();
  }

  if (loading) return <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>;
  if (error) return <Alert variant="error">{error}</Alert>;
  if (!rep) return null;

  return (
    <div className="space-y-6" dir={locale === "ar" ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">{rep.nameAr}</h1>
          <div className="text-sm text-textSecondary font-mono">{rep.code}</div>
        </div>
        <div className="flex gap-2">
          <Link href={`/${locale}/sales/representatives/${rep.id}/statement`}>
            <Button>{t("openStatement")}</Button>
          </Link>
          {canManage && <Button variant="ghost" onClick={() => setEditOpen(true)}>{t("edit")}</Button>}
          {canManage && (
            <Button variant="ghost" onClick={() => void toggleActive()}>
              {rep.active ? t("deactivate") : t("activate")}
            </Button>
          )}
        </div>
      </div>

      {/* Info */}
      <Card>
        <CardBody>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div><dt className="text-textSecondary">{t("nameEn")}</dt><dd>{rep.nameEn ?? "—"}</dd></div>
            <div><dt className="text-textSecondary">{t("phone")}</dt><dd dir="ltr">{rep.phone ?? "—"}</dd></div>
            <div><dt className="text-textSecondary">{t("status")}</dt><dd className={rep.active ? "text-green-600" : "text-textSecondary"}>{rep.active ? t("active") : t("inactive")}</dd></div>
            <div><dt className="text-textSecondary">{t("address")}</dt><dd>{rep.address ?? "—"}</dd></div>
            <div className="md:col-span-2"><dt className="text-textSecondary">{t("notes")}</dt><dd>{rep.notes ?? "—"}</dd></div>
          </dl>
        </CardBody>
      </Card>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label={t("draftInvoices")} value={String(rep.summary.draftInvoiceCount)} />
        <StatCard label={t("confirmedInvoices")} value={String(rep.summary.confirmedInvoiceCount)} />
        <StatCard label={t("confirmedSalesTotal")} value={fmt(rep.summary.confirmedSalesTotal)} />
      </div>

      {editOpen && <RepresentativeFormModal rep={rep} onClose={() => setEditOpen(false)} onSaved={onSaved} />}
    </div>
  );
}
