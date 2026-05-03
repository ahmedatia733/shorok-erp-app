"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../i18n";
import { listVariants, type VariantOption } from "../../../lib/inventory-client";

interface Props {
  id?: string;
  value: string | null;
  onChange: (variantId: string) => void;
  required?: boolean;
  disabled?: boolean;
}

export function VariantPicker({ id, value, onChange, required, disabled }: Props) {
  const locale = useLocale() as AppLocale;
  const [variants, setVariants] = useState<VariantOption[]>([]);

  useEffect(() => {
    let alive = true;
    void listVariants().then((rows) => {
      if (!alive) return;
      setVariants(rows.filter((v) => v.active));
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <select
      id={id}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      required={required}
      disabled={disabled}
      className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary disabled:bg-background"
    >
      <option value="" disabled>
        —
      </option>
      {variants.map((v) => {
        const color = locale === "ar" ? v.sku.colorNameAr : v.sku.colorNameEn;
        return (
          <option key={v.id} value={v.id}>
            {color} · {v.sku.code} · {v.sizeMetersPerBoard} m
          </option>
        );
      })}
    </select>
  );
}
