/**
 * When a different product variant is selected on an invoice line, the line
 * must drop the previous variant's per-line size overrides and load the new
 * variant's own default price — never keep a stale price or size. Sales lines
 * load default_sale_price_per_meter; purchase lines load
 * default_purchase_price_per_meter. This pure helper centralises that reset so
 * it is unit-testable and identical on both screens.
 */
export interface VariantLineReset {
  productVariantId: string;
  unitPrice: string;
  sizeChoice: "";
  customL: string;
  customW: string;
}

export function switchVariantLine(
  variantId: string,
  defaultPrice: string | undefined | null,
): VariantLineReset {
  return {
    productVariantId: variantId,
    unitPrice: defaultPrice ?? "",
    sizeChoice: "",
    customL: "",
    customW: "",
  };
}
