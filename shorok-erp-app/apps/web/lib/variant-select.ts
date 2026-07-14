/**
 * Shared model + search/label helpers for the single product-variant selector
 * that replaces the separate "الكود / اسم الكود / الصنف" columns. One selection
 * determines the exact ProductVariant (never another size/color).
 */
export interface VariantItem {
  id: string;
  skuCode: string;
  colorNameAr: string;
  colorNameEn?: string | null;
  sizeMetersPerBoard: string;
  category?: string | null;
  /** optional display extras (screen-dependent) */
  stock?: string | null;
  price?: string | null;
  cost?: string | null;
}

/** Combined visible label, e.g. "1023 — أصفر — مقاس 5.25 م". */
export function variantLabel(v: VariantItem): string {
  const size = Number(v.sizeMetersPerBoard);
  const sizeStr = Number.isFinite(size) ? `مقاس ${trimNum(v.sizeMetersPerBoard)} م` : v.sizeMetersPerBoard;
  return `${v.skuCode} — ${v.colorNameAr} — ${sizeStr}`;
}

function trimNum(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return String(n); // drops trailing zeros: "5.2500" → "5.25", "4.0000" → "4"
}

/** Everything a variant can be searched by: SKU code, Arabic + English name, color, size, category. */
export function variantSearchText(v: VariantItem): string {
  return [v.skuCode, v.colorNameAr, v.colorNameEn ?? "", v.sizeMetersPerBoard, trimNum(v.sizeMetersPerBoard), v.category ?? ""]
    .join(" ")
    .toLowerCase();
}

/** Filter by a free-text query; every whitespace-separated term must match. */
export function filterVariants(variants: VariantItem[], query: string): VariantItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return variants;
  return variants.filter((v) => {
    const hay = variantSearchText(v);
    return terms.every((t) => hay.includes(t));
  });
}
