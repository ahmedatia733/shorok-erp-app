"use client";

import { useEffect, useState } from "react";
import { listVariants, type VariantOption } from "../../../lib/inventory-client";
import { ProductVariantSelect } from "../product-variant-select";
import { type VariantItem } from "../../../lib/variant-select";

interface Props {
  id?: string;
  value: string | null;
  onChange: (variantId: string) => void;
  required?: boolean;
  disabled?: boolean;
}

/** Thin wrapper so inventory/factory screens share the single searchable
 *  ProductVariantSelect (one control, exact SKU/color/size). */
export function VariantPicker({ value, onChange, disabled }: Props) {
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

  const items: VariantItem[] = variants.map((v) => ({
    id: v.id,
    skuCode: v.sku.code,
    colorNameAr: v.sku.colorNameAr,
    colorNameEn: v.sku.colorNameEn,
    sizeMetersPerBoard: v.sizeMetersPerBoard,
  }));

  return <ProductVariantSelect variants={items} value={value ?? ""} onChange={onChange} disabled={disabled} />;
}
