/**
 * Sales Invoice product-dropdown helpers.
 *
 * The SALE price per meter is entered MANUALLY, so it must never appear in the
 * product dropdown nor auto-fill the form. These helpers build the dropdown
 * option and its secondary line from the per-meter COST only — there is no code
 * path here that can surface the sale price.
 */
import type { VariantItem } from "./variant-select";

export interface SalesVariant {
  id: string;
  skuCode: string;
  skuNameAr: string;
  sizeMetersPerBoard: string;
  /** defaultPurchasePricePerMeter — the auto-loaded cost per meter. */
  defaultCostPrice: string;
}

/** Dropdown item. `price` (sale) is intentionally absent. */
export function toSalesVariantItem(v: SalesVariant): VariantItem {
  return {
    id: v.id,
    skuCode: v.skuCode,
    colorNameAr: v.skuNameAr,
    sizeMetersPerBoard: v.sizeMetersPerBoard,
    cost: v.defaultCostPrice,
  };
}

/** Dropdown secondary line — COST per meter only (never the sale price). */
export function salesVariantExtra(cost?: string | null): string {
  const n = cost == null || cost === "" ? NaN : Number(cost);
  const shown = Number.isNaN(n) ? "—" : n.toLocaleString("en-US");
  return `سعر التكلفة للمتر ${shown}`;
}
