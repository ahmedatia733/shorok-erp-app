import { Decimal } from "decimal.js";
import type { InvoicePdfData, InvoicePdfLine } from "./invoice-template";

/**
 * Maps confirmed/draft invoice records to presentation-only PDF data. Deliberately
 * excludes every internal figure — cost prices, COGS, profit, account IDs, journal
 * IDs — so the customer/supplier document never leaks accounting internals.
 */

const money = (v: unknown) => new Decimal((v as any) ?? 0).toFixed(2);

/** Trim trailing zeros on quantities (e.g. 4.0000 → "4", 5.2500 → "5.25"). */
const qty = (v: unknown) => {
  const d = new Decimal((v as any) ?? 0);
  return d.equals(d.trunc()) ? d.toFixed(0) : d.toString().replace(/0+$/, "").replace(/\.$/, "");
};

const fmtDate = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
};

const nowStamp = (): string => new Date().toISOString().slice(0, 16).replace("T", " ");

export function salesInvoiceToPdfData(inv: any, companyNameAr: string): InvoicePdfData {
  const taxRate = new Decimal(inv.taxRate ?? 0);
  const lines: InvoicePdfLine[] = (inv.lines ?? []).map((l: any) => {
    const lineTotal = new Decimal(l.lineTotal ?? 0);
    // Sales tax is stored at the invoice level; present it per line proportionally.
    const vat = lineTotal.mul(taxRate).div(100);
    return {
      code: l.productVariant?.sku?.code ?? "",
      name: l.productVariant?.sku?.colorNameAr ?? "",
      size: l.productVariant?.sizeMetersPerBoard != null ? `${l.productVariant.sizeMetersPerBoard} م` : "",
      unit: l.unitLabel ?? "وحدة",
      quantity: qty(l.quantity),
      unitPrice: money(l.unitPrice),
      subtotal: lineTotal.toFixed(2),
      vat: vat.toFixed(2),
      total: lineTotal.plus(vat).toFixed(2),
    };
  });

  return {
    kind: "SALES",
    companyName: companyNameAr,
    invoiceNumber: `SI-${inv.invoiceNumber}`,
    status: inv.status,
    branchName: inv.branch?.nameAr ?? "",
    issueDate: fmtDate(inv.invoiceDate) ?? "",
    dueDate: fmtDate(inv.dueDate),
    party: {
      code: inv.customer?.code ?? null,
      name: inv.customer?.nameAr ?? "",
      phone: inv.customer?.phone ?? null,
    },
    lines,
    totals: {
      subtotal: money(inv.subtotal),
      vat: money(inv.taxAmount),
      discount: money(inv.discountAmount),
      grandTotal: money(inv.grandTotal),
    },
    notes: inv.notes ?? null,
    printedAt: nowStamp(),
  };
}

export function purchaseInvoiceToPdfData(inv: any, companyNameAr: string): InvoicePdfData {
  const lines: InvoicePdfLine[] = (inv.lines ?? []).map((l: any) => {
    const lineTotal = new Decimal(l.lineTotal ?? 0);
    const vat = new Decimal(l.taxAmount ?? 0);
    return {
      code: l.productVariant?.sku?.code ?? l.colorCode ?? "",
      name: l.productVariant?.sku?.colorNameAr ?? "",
      size: l.metersQuantity != null ? `${qty(l.metersQuantity)} م` : "",
      unit: l.unitLabel ?? "لوح",
      quantity: qty(l.boardsQuantity),
      unitPrice: money(l.unitPrice),
      subtotal: lineTotal.toFixed(2),
      vat: vat.toFixed(2),
      total: lineTotal.plus(vat).toFixed(2),
    };
  });

  return {
    kind: "PURCHASE",
    companyName: companyNameAr,
    invoiceNumber: inv.invoiceNumber,
    status: inv.status,
    branchName: inv.branch?.nameAr ?? "",
    issueDate: fmtDate(inv.invoiceDate) ?? "",
    dueDate: fmtDate(inv.dueDate),
    party: { name: inv.supplier?.nameAr ?? "" },
    lines,
    totals: {
      subtotal: money(inv.subtotal),
      vat: money(inv.taxAmount),
      grandTotal: money(inv.grandTotal),
    },
    notes: inv.notes ?? null,
    printedAt: nowStamp(),
  };
}
