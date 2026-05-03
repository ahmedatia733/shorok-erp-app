"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../i18n";
import { listBranches, type BranchSummary } from "../../../lib/inventory-client";
import { Label } from "../../ui/label";

interface Props {
  value: string | null;
  onChange: (branchId: string) => void;
  /** When true, autoselect the first branch the user has access to. */
  autoSelect?: boolean;
}

/**
 * Branch dropdown driven by GET /branches. The component itself is locale-
 * aware: it shows nameAr / nameEn based on the active locale.
 */
export function BranchPicker({ value, onChange, autoSelect = true }: Props) {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("inventory");
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void listBranches()
      .then((rows) => {
        if (!alive) return;
        const active = rows.filter((b) => b.active);
        setBranches(active);
        if (autoSelect && !value && active[0]) onChange(active[0].id);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [autoSelect, onChange, value]);

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="branch-picker" className="mb-0">
        {t("branchPicker")}
      </Label>
      <select
        id="branch-picker"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading || branches.length === 0}
        className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
      >
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {locale === "ar" ? b.nameAr : b.nameEn}
          </option>
        ))}
      </select>
    </div>
  );
}
