"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../i18n";
import { Label } from "../ui/label";
import { treasurySelector, type TreasuryRow } from "../../lib/treasuries-client";
import { treasuryOptionLabel } from "../../lib/treasury-format";

/**
 * Shared treasury-native selector for money documents (expenses, receipts,
 * supplier payments). Lists ONLY active, authorized treasuries — optionally
 * filtered to a branch. When `branchId` changes it reloads and clears a now-
 * incompatible selection. `value` and `onChange` speak the treasury's linked
 * glAccountId (kept for backend compatibility); `onPick` also surfaces the full
 * treasury row (id + branch) for callers that submit treasuryId/branchId.
 */
export function TreasuryPicker({
  branchId,
  value,
  onChange,
  onPick,
  includeEmptyOption,
  emptyLabel,
  label,
  disabled,
  testId,
}: {
  branchId?: string | null;
  value: string;
  onChange: (glAccountId: string) => void;
  onPick?: (t: TreasuryRow | null) => void;
  includeEmptyOption?: boolean;
  emptyLabel?: string;
  label?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("treasury");
  const [items, setItems] = useState<TreasuryRow[]>([]);

  useEffect(() => {
    let alive = true;
    void treasurySelector(branchId ?? undefined)
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        // Clear a selection that is no longer valid for this branch.
        if (value && !r.items.some((x) => x.glAccountId === value)) {
          onChange("");
          onPick?.(null);
        }
      })
      .catch(() => alive && setItems([]));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  const handle = (glAccountId: string) => {
    onChange(glAccountId);
    onPick?.(items.find((x) => x.glAccountId === glAccountId) ?? null);
  };

  return (
    <div className="space-y-1">
      {label !== undefined && <Label>{label}</Label>}
      <select
        value={value}
        onChange={(e) => handle(e.target.value)}
        disabled={disabled}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        data-testid={testId ?? "treasury-picker"}
      >
        {includeEmptyOption && <option value="">{emptyLabel ?? t("choose")}</option>}
        {items.map((tr) => (
          <option key={tr.id} value={tr.glAccountId}>{treasuryOptionLabel(tr, locale)}</option>
        ))}
      </select>
    </div>
  );
}
