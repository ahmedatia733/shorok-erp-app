import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { NotFoundError } from "../../common/errors/api-errors";

type Tx = Prisma.TransactionClient;

/** Per original-invoice-line returnable breakdown. Metres are canonical. */
export interface ReturnableLine {
  originalLineId: string;
  productVariantId: string;
  productCode: string | null;
  colorName: string | null;            // sku.color_name_ar — a COLOR, not a product name
  // CURRENT product-master size (mutable); shown only as a hint, never as the
  // historical value. Historical facts come from the ORIGINAL line below.
  currentVariantSize: string | null;
  // HISTORICAL effective board area at posting = originalMeters / originalBoards.
  historicalBoardSize: string | null;
  unitLabel: string;
  lengthM: string | null;              // HISTORICAL chosen dimensions (original line)
  widthM: string | null;
  originalMeters: string;
  originalBoards: string;
  returnedMeters: string;   // Σ CONFIRMED returns only (draft/cancelled excluded)
  returnedBoards: string;
  remainingMeters: string;
  remainingBoards: string;
  // Historical snapshots the caller uses to derive money/COGS (never current):
  originalNetExTax: string;         // line_total (net of line discount, ex-VAT)
  originalGross: string;            // meters × unit_price
  originalDiscount: string;
  originalUnitPrice: string;        // per metre
  originalDiscountPct: string;
  originalTaxRate: string;          // snapshot at posting (fallback: header rate)
  originalLineCogs: string;         // historical COGS for the WHOLE original line
  originalCostPerMeter: string | null; // unit_cost_per_meter_at_posting (null on legacy)
  // TRUE when the line predates persisted metres AND no reliable historical
  // source (dimensions / gross÷price) could reconstruct them → a return for this
  // line must be blocked rather than guessed (never treat boards as metres).
  legacyAmbiguous: boolean;
}

export interface PurchaseReturnableLine {
  originalLineId: string; productVariantId: string;
  productCode: string | null; colorName: string | null;
  currentVariantSize: string | null; historicalBoardSize: string | null;
  unitLabel: string; lengthM: string | null; widthM: string | null;
  originalMeters: string; originalBoards: string;
  returnedMeters: string; returnedBoards: string;
  remainingMeters: string; remainingBoards: string;
  originalUnitPrice: string; originalTaxRate: string; originalNetExTax: string;
}

/**
 * Returnable-quantity engine. For an original invoice it reports, per line, how
 * much is still returnable = original − Σ(CONFIRMED returns). Draft and
 * cancelled returns never consume returnable quantity. Square metres are the
 * canonical validation quantity; board/piece counts are reported alongside.
 *
 * All reads accept an optional tx so a confirm flow can compute returnable
 * INSIDE the same locked transaction that inserts the new confirmed return —
 * that is what makes two concurrent "return the last piece" confirmations safe.
 */
@Injectable()
export class ReturnableService {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx) {
    return tx ?? this.prisma;
  }

  /**
   * Reliable historical metres for a sales line, in strict precedence (§7):
   *   1. persisted meters_quantity (> 0)
   *   2. lengthM × (widthM || 1) × boards  (persisted chosen dimensions)
   *   3. line_total ÷ ((1 − discount%/100) × unit_price)  (gross ÷ per-metre price)
   * `quantity` is a BOARD count and is NEVER used as metres. Returns null when
   * no source is valid → the line is legacy-ambiguous and cannot be returned.
   */
  private deriveSalesMeters(l: {
    metersQuantity: Prisma.Decimal | null; quantity: Prisma.Decimal;
    lengthM: Prisma.Decimal | null; widthM: Prisma.Decimal | null;
    lineTotal: Prisma.Decimal; unitPrice: Prisma.Decimal; discountPct: Prisma.Decimal;
  }): Decimal | null {
    if (l.metersQuantity != null) {
      const m = new Decimal(l.metersQuantity.toString());
      if (m.gt(0)) return m;
    }
    const boards = new Decimal(l.quantity.toString());
    if (l.lengthM != null) {
      const len = new Decimal(l.lengthM.toString());
      const wid = l.widthM != null ? new Decimal(l.widthM.toString()) : new Decimal(1);
      const m = boards.mul(len).mul(wid);
      if (m.gt(0)) return m;
    }
    const unit = new Decimal(l.unitPrice.toString());
    const disc = new Decimal(l.discountPct.toString());
    const factor = new Decimal(1).minus(disc.div(100));
    if (unit.gt(0) && factor.gt(0)) {
      const gross = new Decimal(l.lineTotal.toString()).div(factor);
      const m = gross.div(unit);
      if (m.gt(0)) return m;
    }
    return null;
  }

  // ── SALES ────────────────────────────────────────────────────────────────
  async salesInvoiceReturnable(invoiceId: string, tx?: Tx): Promise<{
    invoice: { id: string; status: string; branchId: string; customerId: string; salesRepresentativeId: string | null; taxRate: string; returnStatus: "NONE" | "PARTIAL" | "FULL" };
    lines: ReturnableLine[];
  }> {
    const db = this.db(tx);
    const inv = await db.salesInvoice.findUnique({
      where: { id: invoiceId },
      include: { lines: { include: { productVariant: { include: { sku: { select: { code: true, colorNameAr: true } } } } } } },
    });
    if (!inv) throw new NotFoundError({ salesInvoiceId: invoiceId });

    // Σ confirmed returned metres/boards per original line, in ONE grouped query.
    const agg = await db.salesReturnLine.groupBy({
      by: ["originalSalesInvoiceLineId"],
      where: { salesReturn: { originalSalesInvoiceId: invoiceId, status: "CONFIRMED" } },
      _sum: { returnedMetersQuantity: true, returnedBoards: true },
    });
    const byLine = new Map(agg.map((a) => [a.originalSalesInvoiceLineId, a._sum]));

    const headerRate = new Decimal(inv.taxRate.toString());
    const lines: ReturnableLine[] = inv.lines.map((l) => {
      const derived = this.deriveSalesMeters(l);
      const legacyAmbiguous = derived == null;
      const originalMeters = derived ?? new Decimal(0);
      const originalBoards = new Decimal(l.quantity.toString());
      const sum = byLine.get(l.id);
      const returnedMeters = new Decimal(sum?.returnedMetersQuantity?.toString() ?? "0");
      const returnedBoards = new Decimal(sum?.returnedBoards?.toString() ?? "0");
      const net = new Decimal(l.lineTotal.toString());
      const gross = new Decimal(l.unitPrice.toString()).mul(originalMeters);
      // Historical line COGS: meter-based snapshot if present, else legacy per-board.
      const lineCogs = l.lineCogsAtPosting != null
        ? new Decimal(l.lineCogsAtPosting.toString())
        : new Decimal(l.quantity.toString()).mul(new Decimal(l.unitCostAtPosting?.toString() ?? "0"));
      return {
        originalLineId: l.id,
        productVariantId: l.productVariantId,
        productCode: l.productVariant?.sku?.code ?? null,
        colorName: l.productVariant?.sku?.colorNameAr ?? null,
        currentVariantSize: l.productVariant ? new Decimal(l.productVariant.sizeMetersPerBoard.toString()).toFixed(4) : null,
        historicalBoardSize: !legacyAmbiguous && originalBoards.gt(0) ? originalMeters.div(originalBoards).toFixed(4) : null,
        unitLabel: l.unitLabel,
        lengthM: l.lengthM != null ? new Decimal(l.lengthM.toString()).toFixed(4) : null,
        widthM: l.widthM != null ? new Decimal(l.widthM.toString()).toFixed(4) : null,
        originalMeters: originalMeters.toFixed(4),
        originalBoards: originalBoards.toFixed(4),
        returnedMeters: returnedMeters.toFixed(4),
        returnedBoards: returnedBoards.toFixed(4),
        remainingMeters: originalMeters.minus(returnedMeters).toFixed(4),
        remainingBoards: originalBoards.minus(returnedBoards).toFixed(4),
        originalNetExTax: net.toFixed(2),
        originalGross: gross.toFixed(2),
        originalDiscount: gross.minus(net).toFixed(2),
        originalUnitPrice: new Decimal(l.unitPrice.toString()).toFixed(2),
        originalDiscountPct: new Decimal(l.discountPct.toString()).toFixed(2),
        originalTaxRate: (l.taxRateAtPosting != null ? new Decimal(l.taxRateAtPosting.toString()) : headerRate).toFixed(2),
        originalLineCogs: lineCogs.toFixed(2),
        originalCostPerMeter: l.unitCostPerMeterAtPosting != null ? new Decimal(l.unitCostPerMeterAtPosting.toString()).toFixed(4) : null,
        legacyAmbiguous,
      };
    });
    return {
      invoice: {
        id: inv.id, status: inv.status, branchId: inv.branchId, customerId: inv.customerId,
        salesRepresentativeId: inv.salesRepresentativeId, taxRate: headerRate.toFixed(2),
        returnStatus: this.statusOf(lines),
      },
      lines,
    };
  }

  /** Invoice-level return status computed from remaining metres across lines. */
  private statusOf(lines: Array<{ originalMeters: string; remainingMeters: string }>): "NONE" | "PARTIAL" | "FULL" {
    const orig = lines.reduce((a, l) => a.plus(l.originalMeters), new Decimal(0));
    const remaining = lines.reduce((a, l) => a.plus(l.remainingMeters), new Decimal(0));
    if (remaining.gte(orig)) return "NONE";
    if (remaining.lte(0)) return "FULL";
    return "PARTIAL";
  }

  // ── PURCHASE ─────────────────────────────────────────────────────────────
  async purchaseInvoiceReturnable(invoiceId: string, tx?: Tx): Promise<{
    invoice: { id: string; status: string; branchId: string; supplierId: string; returnStatus: "NONE" | "PARTIAL" | "FULL" };
    lines: PurchaseReturnableLine[];
  }> {
    const db = this.db(tx);
    const inv = await db.purchaseInvoice.findUnique({
      where: { id: invoiceId },
      include: { lines: { include: { productVariant: { include: { sku: { select: { code: true, colorNameAr: true } } } } } } },
    });
    if (!inv) throw new NotFoundError({ purchaseInvoiceId: invoiceId });

    const agg = await db.purchaseReturnLine.groupBy({
      by: ["originalPurchaseInvoiceLineId"],
      where: { purchaseReturn: { originalPurchaseInvoiceId: invoiceId, status: "CONFIRMED" } },
      _sum: { returnedMetersQuantity: true, returnedBoards: true },
    });
    const byLine = new Map(agg.map((a) => [a.originalPurchaseInvoiceLineId, a._sum]));

    const lines: PurchaseReturnableLine[] = inv.lines.map((l) => {
      const originalMeters = new Decimal(l.metersQuantity.toString());
      const originalBoards = new Decimal(l.boardsQuantity.toString());
      const sum = byLine.get(l.id);
      const returnedMeters = new Decimal(sum?.returnedMetersQuantity?.toString() ?? "0");
      const returnedBoards = new Decimal(sum?.returnedBoards?.toString() ?? "0");
      return {
        originalLineId: l.id,
        productVariantId: l.productVariantId,
        productCode: l.productVariant?.sku?.code ?? null,
        colorName: l.productVariant?.sku?.colorNameAr ?? null,
        currentVariantSize: l.productVariant ? new Decimal(l.productVariant.sizeMetersPerBoard.toString()).toFixed(4) : null,
        // Purchase lines persist metersQuantity + boardsQuantity → historical board area is exact.
        historicalBoardSize: originalBoards.gt(0) ? originalMeters.div(originalBoards).toFixed(4) : null,
        unitLabel: l.unitLabel ?? "متر",
        lengthM: l.lengthM != null ? new Decimal(l.lengthM.toString()).toFixed(4) : null,
        widthM: l.widthM != null ? new Decimal(l.widthM.toString()).toFixed(4) : null,
        originalMeters: originalMeters.toFixed(4),
        originalBoards: originalBoards.toFixed(4),
        returnedMeters: returnedMeters.toFixed(4),
        returnedBoards: returnedBoards.toFixed(4),
        remainingMeters: originalMeters.minus(returnedMeters).toFixed(4),
        remainingBoards: originalBoards.minus(returnedBoards).toFixed(4),
        originalUnitPrice: new Decimal(l.unitPrice.toString()).toFixed(2), // per metre, ex-tax
        originalTaxRate: new Decimal((l.taxRateAtPosting ?? l.taxRate).toString()).toFixed(2),
        originalNetExTax: new Decimal(l.lineTotal.toString()).toFixed(2),
      };
    });
    return {
      invoice: { id: inv.id, status: inv.status, branchId: inv.branchId, supplierId: inv.supplierId, returnStatus: this.statusOf(lines) },
      lines,
    };
  }
}
