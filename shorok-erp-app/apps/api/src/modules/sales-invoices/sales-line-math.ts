import { Decimal } from "decimal.js";

/**
 * Per-METRE sales line maths — the single authority for what a sales line is
 * worth. Extracted verbatim from the confirm/create path so that creation,
 * draft editing and confirmed-invoice revision all price a line identically;
 * a revision that recomputed totals its own way would eventually drift from
 * the invoice it is revising.
 *
 * `quantity` is a BOARD count. The metres are always derived server-side —
 * a client-sent total is never trusted:
 *
 *   meters        = boards × (lengthM × (widthM ?? 1))   ← custom / كبير / صغير
 *                 = boards × variant.sizeMetersPerBoard  ← nothing chosen
 *   grossLineSale = meters × unitPrice(per metre)
 *   discountAmt   = grossLineSale × discountPct/100
 *   lineTotal     = grossLineSale − discountAmt
 *   lineCost      = meters × costPrice(per metre)
 */

export interface SalesLineInput {
  productVariantId: string;
  quantity: string;
  lengthM?: string | null;
  widthM?: string | null;
  unitLabel?: string;
  unitPrice: string;
  costPrice?: string;
  discountPct?: string;
  note?: string | null;
}

export interface SalesLineTotals {
  productVariantId: string;
  quantity: Decimal;
  lengthM: Decimal | null;
  widthM: Decimal | null;
  meters: Decimal;
  unitLabel: string;
  unitPrice: Decimal;
  costPrice: Decimal;
  discountPct: Decimal;
  discountAmt: Decimal;
  lineTotal: Decimal;
  lineCost: Decimal;
  note: string | null;
}

export function computeSalesLineTotals(
  lines: SalesLineInput[],
  sizes: Map<string, Decimal>,
): SalesLineTotals[] {
  return lines.map((line) => {
    const boards = new Decimal(line.quantity);
    const variantSize = sizes.get(line.productVariantId) ?? new Decimal(0);
    const lengthM = line.lengthM ? new Decimal(line.lengthM) : null;
    const widthM = line.widthM ? new Decimal(line.widthM) : null;
    const meters = lengthM ? boards.mul(lengthM).mul(widthM ?? new Decimal(1)) : boards.mul(variantSize);
    const unitPrice = new Decimal(line.unitPrice);
    const costPrice = new Decimal(line.costPrice ?? "0");
    const discountPct = new Decimal(line.discountPct ?? "0");

    const grossLineSale = meters.mul(unitPrice);
    const discountAmt = grossLineSale.mul(discountPct.div(100));
    const lineTotal = grossLineSale.minus(discountAmt);
    const lineCost = meters.mul(costPrice);

    return {
      productVariantId: line.productVariantId,
      quantity: boards,
      lengthM,
      widthM,
      meters,
      unitLabel: line.unitLabel ?? "متر",
      unitPrice,
      costPrice,
      discountPct,
      discountAmt,
      lineTotal,
      lineCost,
      note: line.note ?? null,
    };
  });
}

/** Header totals from priced lines. `subtotal` is already net of line discounts. */
export function computeSalesInvoiceTotals(lines: SalesLineTotals[], taxRate: Decimal) {
  const subtotal = lines.reduce((acc, l) => acc.add(l.lineTotal), new Decimal(0));
  const discountAmount = lines.reduce((acc, l) => acc.add(l.discountAmt), new Decimal(0));
  const taxAmount = subtotal.mul(taxRate).div(100);
  const grandTotal = subtotal.add(taxAmount);
  const totalCost = lines.reduce((acc, l) => acc.add(l.lineCost), new Decimal(0));
  return { subtotal, discountAmount, taxRate, taxAmount, grandTotal, totalCost };
}
