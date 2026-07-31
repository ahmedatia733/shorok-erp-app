import { Decimal } from "decimal.js";
import type { ReturnPdfData, ReturnPdfLine } from "./return-template";

/**
 * Maps a stored sales/purchase return record to presentation-only PDF data.
 * Reads ONLY values already persisted on the return (and its original-invoice
 * snapshot) — nothing is recomputed from current master prices, and no accounting
 * side effect occurs.
 */

const money = (v: unknown) => new Decimal((v as never) ?? 0).toFixed(2);

/** Trim trailing zeros on quantities: 4.0000 → "4", 5.2500 → "5.25". */
const qty = (v: unknown) => {
  const d = new Decimal((v as never) ?? 0);
  return d.equals(d.trunc()) ? d.toFixed(0) : d.toString().replace(/0+$/, "").replace(/\.$/, "");
};

const fmtDate = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
};

const stamp = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 16).replace("T", " ");
};

const nowStamp = () => new Date().toISOString().slice(0, 16).replace("T", " ");

const dims = (l: any): string => {
  if (l.lengthM == null) return "—";
  const len = qty(l.lengthM);
  return l.widthM != null ? `${len} × ${qty(l.widthM)}` : len;
};

const perBoard = (meters: unknown, boards: unknown): Decimal => {
  const b = new Decimal((boards as never) ?? 0);
  return b.gt(0) ? new Decimal((meters as never) ?? 0).div(b) : new Decimal(0);
};

interface PdfOpts { locale: "ar" | "en"; companyName: string; journalEntryNumber: string | null }

export function salesReturnToPdfData(ret: any, opts: PdfOpts): ReturnPdfData {
  const lines: ReturnPdfLine[] = (ret.lines ?? []).map((l: any): ReturnPdfLine => {
    const mpb = perBoard(l.returnedMetersQuantity, l.returnedBoards);
    const unit = new Decimal(l.originalSalePricePerMeter ?? 0);
    return {
      code: l.productVariant?.sku?.code ?? "",
      name: l.productVariant?.sku?.colorNameAr ?? "",
      color: l.productVariant?.sku?.colorNameAr ?? "",
      dimensions: dims(l),
      boards: qty(l.returnedBoards),
      metersPerBoard: mpb.toFixed(2),
      meters: qty(l.returnedMetersQuantity),
      unitPrice: money(l.originalSalePricePerMeter),
      pricePerBoard: money(unit.mul(mpb)),
      discount: money(l.returnDiscount),
      net: money(l.returnNetExTax),
      taxRate: `${qty(l.originalTaxRate)}%`,
      tax: money(l.returnTax),
      total: money(l.returnTotal),
      reason: l.reason ?? "",
      note: l.note ?? "",
    };
  });
  const net = new Decimal(ret.subtotal ?? 0);        // header.subtotal = net ex-tax
  const discount = new Decimal(ret.discountTotal ?? 0);
  return {
    kind: "SALES",
    locale: opts.locale,
    companyName: opts.companyName,
    returnNumber: `SR-${ret.returnNumber}`,
    status: (ret.status as ReturnPdfData["status"]) ?? "DRAFT",
    returnDate: fmtDate(ret.returnDate) ?? "",
    originalInvoiceNumber: ret.originalInvoice?.invoiceNumber != null ? `SI-${ret.originalInvoice.invoiceNumber}` : null,
    originalInvoiceDate: fmtDate(ret.originalInvoice?.invoiceDate),
    branchName: ret.branch?.nameAr ?? "",
    partyCode: ret.customer?.code ?? null,
    partyName: ret.customer?.nameAr ?? "",
    reason: ret.reason ?? null,
    notes: ret.notes ?? null,
    lines,
    totals: {
      subtotal: money(net.plus(discount)), // gross before discount
      discount: money(discount),
      net: money(net),
      tax: money(ret.taxTotal),
      grandTotal: money(ret.grandTotal),
      cogs: money(ret.cogsReversalTotal),
      inventoryOut: null,
    },
    confirmedAt: ret.status === "CONFIRMED" ? stamp(ret.confirmedAt) : null,
    confirmedBy: ret.status === "CONFIRMED" ? (ret.confirmer?.name ?? null) : null,
    journalEntryNumber: ret.status === "CONFIRMED" ? opts.journalEntryNumber : null,
    printedAt: nowStamp(),
  };
}

export function purchaseReturnToPdfData(ret: any, opts: PdfOpts): ReturnPdfData {
  const lines: ReturnPdfLine[] = (ret.lines ?? []).map((l: any): ReturnPdfLine => {
    const mpb = perBoard(l.returnedMetersQuantity, l.returnedBoards);
    const unit = new Decimal(l.originalPurchasePricePerMeter ?? 0);
    return {
      code: l.productVariant?.sku?.code ?? "",
      name: l.productVariant?.sku?.colorNameAr ?? "",
      color: l.productVariant?.sku?.colorNameAr ?? "",
      dimensions: dims(l),
      boards: qty(l.returnedBoards),
      metersPerBoard: mpb.toFixed(2),
      meters: qty(l.returnedMetersQuantity),
      unitPrice: money(l.originalPurchasePricePerMeter),
      pricePerBoard: money(unit.mul(mpb)),
      discount: null,
      net: money(l.returnNetExTax),
      taxRate: `${qty(l.originalTaxRate)}%`,
      tax: money(l.returnTax),
      total: money(l.returnTotal),
      reason: l.reason ?? "",
      note: l.note ?? "",
    };
  });
  return {
    kind: "PURCHASE",
    locale: opts.locale,
    companyName: opts.companyName,
    returnNumber: `PR-${ret.returnNumber}`,
    status: (ret.status as ReturnPdfData["status"]) ?? "DRAFT",
    returnDate: fmtDate(ret.returnDate) ?? "",
    originalInvoiceNumber: ret.originalInvoice?.invoiceNumber != null ? `PINV-${ret.originalInvoice.invoiceNumber}` : null,
    originalInvoiceDate: fmtDate(ret.originalInvoice?.invoiceDate),
    branchName: ret.branch?.nameAr ?? "",
    partyCode: null,
    partyName: ret.supplier?.nameAr ?? "",
    reason: ret.reason ?? null,
    notes: ret.notes ?? null,
    lines,
    totals: {
      subtotal: null,
      discount: null,
      net: money(ret.subtotal),
      tax: money(ret.taxTotal),
      grandTotal: money(ret.grandTotal),
      cogs: null,
      inventoryOut: money(ret.inventoryValueOut),
    },
    confirmedAt: ret.status === "CONFIRMED" ? stamp(ret.confirmedAt) : null,
    confirmedBy: ret.status === "CONFIRMED" ? (ret.confirmer?.name ?? null) : null,
    journalEntryNumber: ret.status === "CONFIRMED" ? opts.journalEntryNumber : null,
    printedAt: nowStamp(),
  };
}
