"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Input } from "../../../../../components/ui/input";
import { Modal } from "../../../../../components/ui/modal";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { useHasRole } from "../../../../../lib/auth";
import { ApiClientError } from "../../../../../lib/api-client";
import {
  createRepresentative,
  listRepresentatives,
  updateRepresentative,
  type SalesRepresentative,
} from "../../../../../lib/sales-representatives-client";
import { RepresentativeFormModal } from "../../../../../components/sales-representatives/representative-form-modal";

export default function SalesRepresentativesPage() {
  const t = useTranslations("salesReps");
  const locale = useLocale() as AppLocale;
  const canManage = useHasRole("ACCOUNTANT"); // OWNER (bypass) or ACCOUNTANT

  const [reps, setReps] = useState<SalesRepresentative[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");

  const [modalOpen, setModalOpen] = useState(false);
  const [editRep, setEditRep] = useState<SalesRepresentative | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReps(await listRepresentatives({ search: search || undefined, status }));
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [search, status, locale, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleActive(rep: SalesRepresentative) {
    const updated = await updateRepresentative(rep.id, { active: !rep.active });
    setReps((prev) => prev.map((r) => (r.id === rep.id ? updated : r)));
  }

  function onSaved(saved: SalesRepresentative) {
    setReps((prev) => {
      const exists = prev.some((r) => r.id === saved.id);
      return exists ? prev.map((r) => (r.id === saved.id ? saved : r)) : [...prev, saved];
    });
    setModalOpen(false);
  }

  return (
    <div className="space-y-6" dir={locale === "ar" ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        {canManage && (
          <Button onClick={() => { setEditRep(null); setModalOpen(true); }}>+ {t("new")}</Button>
        )}
      </div>

      {/* Filters */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <label className="block text-xs text-textSecondary mb-1">{t("search")}</label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("search")}
            />
          </div>
          <div>
            <label className="block text-xs text-textSecondary mb-1">{t("status")}</label>
            <select
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="all">{t("all")}</option>
              <option value="active">{t("active")}</option>
              <option value="inactive">{t("inactive")}</option>
            </select>
          </div>
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {loading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
        </div>
      ) : reps.length === 0 ? (
        <div className="text-center text-textSecondary py-10">{t("noResults")}</div>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>{t("code")}</TH>
              <TH>{t("nameAr")}</TH>
              <TH>{t("nameEn")}</TH>
              <TH>{t("phone")}</TH>
              <TH>{t("status")}</TH>
              <TH>{t("actions")}</TH>
            </TR>
          </THead>
          <TBody>
            {reps.map((r) => (
              <TR key={r.id}>
                <TD className="font-mono text-xs">{r.code}</TD>
                <TD>{r.nameAr}</TD>
                <TD className="text-textSecondary">{r.nameEn ?? "—"}</TD>
                <TD dir="ltr" className="text-right">{r.phone ?? "—"}</TD>
                <TD>
                  <span className={r.active ? "text-green-600" : "text-textSecondary"}>
                    {r.active ? t("active") : t("inactive")}
                  </span>
                </TD>
                <TD>
                  <div className="flex gap-2 text-xs">
                    <Link href={`/${locale}/sales/representatives/${r.id}`} className="text-blue-600 hover:underline">{t("details")}</Link>
                    <Link href={`/${locale}/sales/representatives/${r.id}/statement`} className="text-blue-600 hover:underline">{t("statement")}</Link>
                    {canManage && (
                      <>
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => { setEditRep(r); setModalOpen(true); }}>
                          {t("edit")}
                        </button>
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => void toggleActive(r)}>
                          {r.active ? t("deactivate") : t("activate")}
                        </button>
                      </>
                    )}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {modalOpen && (
        <RepresentativeFormModal
          rep={editRep}
          onClose={() => setModalOpen(false)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
