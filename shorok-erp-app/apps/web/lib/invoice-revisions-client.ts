"use client";

import { apiCall } from "./api-client";

/**
 * Confirmed-invoice revision.
 *
 * Two steps, always in this order: `preview…Revision` calculates everything and
 * writes nothing, then `execute…Revision` commits — but only against the exact
 * fingerprint that preview returned. If anything moved in between, the server
 * rejects it and the owner has to look at a fresh comparison first.
 */

export interface RevisionIssue {
  code: string;
  messageAr: string;
  context?: Record<string, string | number | null>;
}

export interface RevisionLineDiff {
  lineId: string | null;
  productVariantId: string;
  productCode: string | null;
  colorName: string | null;
  sizeLabel: string | null;
  change: "ADDED" | "REMOVED" | "CHANGED" | "UNCHANGED";
  before: Record<string, string | null> | null;
  after: Record<string, string | null> | null;
  linkedReturnedBoards: string;
  blocked: RevisionIssue[];
}

export interface RevisionStockEffect {
  branchId: string;
  branchNameAr: string;
  productVariantId: string;
  productCode: string | null;
  boardsDelta: string;
  metersDelta: string;
}

export interface RevisionJournalPreview {
  kind: "REVERSAL" | "REPLACEMENT" | "REVERSAL_COGS" | "REPLACEMENT_COGS" | "VALUATION_ADJUSTMENT";
  descriptionAr: string;
  postingDate: string;
  totalDebit: string;
  totalCredit: string;
  lines: Array<{
    accountId: string;
    accountCode: string;
    accountNameAr: string;
    debit: string;
    credit: string;
    partyType: "CUSTOMER" | "SUPPLIER" | null;
    partyId: string | null;
    branchId: string | null;
    note: string | null;
  }>;
}

export interface RevisionValuation {
  replayRequired: boolean;
  reasonAr: string;
  replayStartAt: string | null;
  variants: Array<{
    productVariantId: string;
    productCode: string | null;
    sizeLabel: string | null;
    currentWacPerMeter: string;
    projectedWacPerMeter: string;
    currentGlobalMeters: string;
    projectedGlobalMeters: string;
    currentInventoryValue: string;
    projectedInventoryValue: string;
    inventoryValueDelta: string;
    cogsDelta: string;
    replayEventCount: number;
    replayReproducedCurrentState: boolean;
  }>;
  totalInventoryValueDelta: string;
  totalCogsDelta: string;
}

export interface RevisionPartyImpact {
  partyType: "CUSTOMER" | "SUPPLIER";
  partyId: string;
  partyNameAr: string;
  balanceDelta: string;
  allocatedAmount: string;
  outstandingAfter: string;
  creditAfter: string;
}

export interface InvoiceRevisionPreview {
  invoiceId: string;
  invoiceNumber: string;
  invoiceKind: "SALES" | "PURCHASE";
  currentRevision: number;
  proposedRevision: number;
  currentStatus: string;
  resultingStatus: string;
  header: Array<{ field: string; before: string | null; after: string | null }>;
  currentLines: Array<Record<string, string | null>>;
  revisedLines: Array<Record<string, string | null>>;
  lineDiffs: RevisionLineDiff[];
  currentTotals: Record<string, string>;
  revisedTotals: Record<string, string>;
  totalDelta: string;
  stockReversal: RevisionStockEffect[];
  stockApplication: RevisionStockEffect[];
  branchQuantityDelta: RevisionStockEffect[];
  linkedReturns: Array<{ returnId: string; returnNumber: string; status: string; date: string; boards: string }>;
  linkedVouchers: Array<{ voucherId: string; voucherNumber: string; date: string; amount: string; allocated: string }>;
  partyImpactBefore: RevisionPartyImpact | null;
  partyImpactAfter: RevisionPartyImpact | null;
  valuation: RevisionValuation;
  journals: RevisionJournalPreview[];
  documentDate: string;
  postingDate: string;
  crossesClosedPeriod: boolean;
  periodNoteAr: string | null;
  blocking: RevisionIssue[];
  warnings: RevisionIssue[];
  previewFingerprint: string;
  committedChanges: 0;
}

export interface InvoiceRevisionSummary {
  id: string;
  revisionNumber: number;
  previousRevisionNumber: number;
  reason: string;
  status: string;
  documentDate: string;
  previousDocumentDate: string;
  postingDate: string;
  crossesClosedPeriod: boolean;
  revisedBy: string;
  revisedByName: string | null;
  createdAt: string;
  totalDelta: string;
  stockDelta: RevisionStockEffect[];
  partyDelta: { before: RevisionPartyImpact | null; after: RevisionPartyImpact | null } | null;
  valuation: RevisionValuation | null;
  reversalJournalEntryIds: string[];
  replacementJournalEntryIds: string[];
  valuationJournalEntryIds: string[];
  reversalMovementIds: string[];
  replacementMovementIds: string[];
}

export interface InvoiceRevisionHistory {
  invoiceId: string;
  invoiceNumber: string;
  currentRevision: number;
  status: string;
  revisions: InvoiceRevisionSummary[];
}

export interface InvoiceRevisionDetail extends InvoiceRevisionSummary {
  beforeSnapshot: { header: Record<string, unknown>; lines: Array<Record<string, string | null>> };
  afterSnapshot: { header: Record<string, unknown>; lines: Array<Record<string, string | null>> };
  delta: Record<string, unknown>;
}

export interface InvoiceRevisionResult {
  revision: InvoiceRevisionSummary;
  reversalJournalEntryIds: string[];
  replacementJournalEntryIds: string[];
  valuationJournalEntryIds: string[];
  idempotentReplay: boolean;
}

export interface SalesRevisionPayload {
  invoiceDate: string;
  dueDate: string | null;
  customerId: string;
  branchId: string;
  salesRepresentativeId: string | null;
  taxRate: string;
  notes: string | null;
  lines: Array<{
    lineId?: string;
    productVariantId: string;
    quantity: string;
    lengthM?: string;
    widthM?: string;
    unitLabel?: string;
    unitPrice: string;
    costPrice?: string;
    discountPct?: string;
    note?: string;
  }>;
}

export interface PurchaseRevisionPayload {
  invoiceDate: string;
  dueDate: string | null;
  supplierId: string;
  branchId: string;
  basedOn: string | null;
  docDirection: string | null;
  customsNumber: string | null;
  notes: string | null;
  lines: Array<{
    lineId?: string;
    productVariantId: string;
    boardsQuantity: string;
    lengthM?: string;
    widthM?: string;
    heightM?: string;
    colorCode?: string | null;
    unitLabel?: string | null;
    unitPrice: string;
    taxRate?: string;
    isFree?: boolean;
  }>;
}

/**
 * A key that is stable for one submission attempt but different for the next.
 * Two clicks on the same button reuse it, so the server collapses them into a
 * single revision instead of posting twice.
 */
export function newRevisionIdempotencyKey(invoiceId: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `rev-${invoiceId.slice(0, 8)}-${Date.now()}-${random}`;
}

export const previewSalesRevision = (
  invoiceId: string,
  body: { expectedRevisionNumber: number; reason: string; payload: SalesRevisionPayload },
) => apiCall<InvoiceRevisionPreview>(`/sales-invoices/${invoiceId}/revisions/preview`, { method: "POST", body });

export const executeSalesRevision = (
  invoiceId: string,
  body: {
    expectedRevisionNumber: number;
    previewFingerprint: string;
    reason: string;
    idempotencyKey: string;
    acknowledgedWarnings: string[];
    payload: SalesRevisionPayload;
  },
) => apiCall<InvoiceRevisionResult>(`/sales-invoices/${invoiceId}/revisions`, { method: "POST", body });

export const listSalesRevisions = (invoiceId: string) =>
  apiCall<InvoiceRevisionHistory>(`/sales-invoices/${invoiceId}/revisions`);

export const getSalesRevision = (invoiceId: string, revisionNumber: number) =>
  apiCall<InvoiceRevisionDetail>(`/sales-invoices/${invoiceId}/revisions/${revisionNumber}`);

export const previewPurchaseRevision = (
  invoiceId: string,
  body: { expectedRevisionNumber: number; reason: string; payload: PurchaseRevisionPayload },
) => apiCall<InvoiceRevisionPreview>(`/purchase-invoices/${invoiceId}/revisions/preview`, { method: "POST", body });

export const executePurchaseRevision = (
  invoiceId: string,
  body: {
    expectedRevisionNumber: number;
    previewFingerprint: string;
    reason: string;
    idempotencyKey: string;
    acknowledgedWarnings: string[];
    payload: PurchaseRevisionPayload;
  },
) => apiCall<InvoiceRevisionResult>(`/purchase-invoices/${invoiceId}/revisions`, { method: "POST", body });

export const listPurchaseRevisions = (invoiceId: string) =>
  apiCall<InvoiceRevisionHistory>(`/purchase-invoices/${invoiceId}/revisions`);

export const getPurchaseRevision = (invoiceId: string, revisionNumber: number) =>
  apiCall<InvoiceRevisionDetail>(`/purchase-invoices/${invoiceId}/revisions/${revisionNumber}`);

/** «مؤكدة — معدلة مرتين» and friends. Revision 1 is the original, so no badge. */
export function revisionBadgeAr(revisionNumber: number): string | null {
  const times = revisionNumber - 1;
  if (times <= 0) return null;
  if (times === 1) return "معدلة مرة";
  if (times === 2) return "معدلة مرتين";
  return `معدلة ${times} مرات`;
}

/** «تم التعديل — النسخة 3» */
export function revisionVersionLabelAr(revisionNumber: number): string {
  return `تم التعديل — النسخة ${revisionNumber}`;
}
