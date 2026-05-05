"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../i18n";
import { Label } from "../../ui/label";
import { listSuppliers, type SupplierRow } from "../../../lib/suppliers-client";

interface Props {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  /** When true the picker still shows archived suppliers (for read-only views). */
  includeArchived?: boolean;
}

/**
 * Shared supplier dropdown for the factory ledger flows.
 * Hides archived suppliers from write paths so an inactive supplier can't
 * be picked for a new entry/payment (the API rejects them anyway).
 */
export function SupplierPicker({ value, onChange, disabled, includeArchived }: Props) {
  const t = useTranslations("factory_orders");
  const locale = useLocale() as AppLocale;
  const [suppliers, setSuppliers] = useState<SupplierRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listSuppliers().then((rows) => {
      if (cancelled) return;
      const filtered = includeArchived ? rows : rows.filter((s) => s.active);
      setSuppliers(filtered);
      const first = filtered[0];
      if (!value && first) onChange(first.id);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived]);

  return (
    <div>
      <Label htmlFor="supplier">{t("supplier")}</Label>
      <select
        id="supplier"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled || !suppliers}
        className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
      >
        {!suppliers ? <option value="">…</option> : null}
        {suppliers?.length === 0 ? (
          <option value="" disabled>
            {t("noSuppliers")}
          </option>
        ) : null}
        {suppliers?.map((s) => (
          <option key={s.id} value={s.id}>
            {locale === "ar" ? s.nameAr : s.nameEn}
            {s.active ? "" : ` · ${t("archivedTag")}`}
          </option>
        ))}
      </select>
    </div>
  );
}
