import { Decimal } from "decimal.js";

/**
 * Per-METRE purchase line maths — the single authority for what a purchase line
 * costs. Extracted from the create path so creation and confirmed-invoice
 * revision derive quantities, totals and tax through one function.
 *
 *   meters    = boards × (lengthM × (widthM ?? 1))   ← custom / كبير / صغير
 *             = boards × variant.sizeMetersPerBoard  ← nothing chosen
 *   lineTotal = meters × unitPrice(per metre, ex-tax)   (0 for a free line)
 *   taxAmount = lineTotal × taxRate/100                 (0 for a free line)
 */

export interface PurchaseLineInput {
  productVariantId: string;
  boardsQuantity: string;
  lengthM?: string | null;
  widthM?: string | null;
  heightM?: string | null;
  colorCode?: string | null;
  unitLabel?: string | null;
  unitPrice: string;
  taxRate?: string;
  isFree?: boolean;
}

export interface PurchaseLineTotals {
  productVariantId: string;
  colorCode: string | null;
  boardsQuantity: Decimal;
  lengthM: Decimal | null;
  widthM: Decimal | null;
  heightM: Decimal | null;
  metersQuantity: Decimal;
  unitLabel: string | null;
  unitPrice: Decimal;
  lineTotal: Decimal;
  taxRate: Decimal;
  taxAmount: Decimal;
  isFree: boolean;
}

export function computePurchaseLineTotals(
  lines: PurchaseLineInput[],
  sizes: Map<string, Decimal>,
): PurchaseLineTotals[] {
  return lines.map((line) => {
    const boards = new Decimal(line.boardsQuantity);
    const lengthM = line.lengthM ? new Decimal(line.lengthM) : null;
    const widthM = line.widthM ? new Decimal(line.widthM) : null;
    const variantSize = sizes.get(line.productVariantId) ?? new Decimal(0);
    const metersQuantity = lengthM
      ? boards.mul(lengthM).mul(widthM ?? new Decimal(1))
      : boards.mul(variantSize);

    const unitPrice = new Decimal(line.unitPrice);
    const taxRate = new Decimal(line.taxRate ?? "0");
    const isFree = line.isFree ?? false;
    const lineTotal = isFree ? new Decimal(0) : metersQuantity.mul(unitPrice);
    const taxAmount = isFree ? new Decimal(0) : lineTotal.mul(taxRate).div(100);

    return {
      productVariantId: line.productVariantId,
      colorCode: line.colorCode ?? null,
      boardsQuantity: boards,
      lengthM,
      widthM,
      heightM: line.heightM ? new Decimal(line.heightM) : null,
      metersQuantity,
      unitLabel: line.unitLabel ?? null,
      unitPrice,
      lineTotal,
      taxRate,
      taxAmount,
      isFree,
    };
  });
}

export function computePurchaseInvoiceTotals(lines: PurchaseLineTotals[]) {
  const subtotal = lines.reduce((acc, l) => acc.add(l.lineTotal), new Decimal(0));
  const taxAmount = lines.reduce((acc, l) => acc.add(l.taxAmount), new Decimal(0));
  return { subtotal, taxAmount, grandTotal: subtotal.add(taxAmount) };
}
