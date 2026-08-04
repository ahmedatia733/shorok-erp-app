import { z } from "zod";

/**
 * Confirmed-invoice revision (P7).
 *
 * A revision never edits posted history. It reverses the currently effective
 * version of a CONFIRMED invoice, reposts the revised one and keeps both. The
 * invoice number and status are untouched; only the revision number advances.
 *
 * The payload deliberately mirrors the CREATE schemas of each invoice, minus
 * anything a revision may not change (invoice number, order link). No field is
 * invented here that the underlying invoice does not already store.
 */

const MoneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/);
const PctStr = z.string().regex(/^\d+(\.\d{1,2})?$/);
const QtyStr = z.string().regex(/^\d+(\.\d{1,4})?$/);
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Client-supplied, so two tabs/retries of the same intent collapse to one. */
const IdempotencyKey = z.string().min(8).max(120).regex(/^[A-Za-z0-9:_.-]+$/);
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const Reason = z.string().trim().min(3).max(500);

// ── Sales ─────────────────────────────────────────────────────────────────

export const SalesInvoiceRevisionLineSchema = z.object({
  /**
   * The id of the line this replaces. Present → the row is UPDATED in place so
   * its identity (and therefore any confirmed return's foreign key) survives.
   * Absent → a genuinely new line.
   */
  lineId: z.string().uuid().optional(),
  productVariantId: z.string().uuid(),
  quantity: QtyStr, // BOARDS
  lengthM: QtyStr.optional(),
  widthM: QtyStr.optional(),
  unitLabel: z.string().max(30).optional().default("وحدة"),
  /** Per metre, entered by hand. Never defaulted from cost or WAC. */
  unitPrice: MoneyStr,
  costPrice: MoneyStr.optional().default("0"),
  discountPct: PctStr.optional().default("0"),
  note: z.string().max(300).optional(),
});
export type SalesInvoiceRevisionLine = z.infer<typeof SalesInvoiceRevisionLineSchema>;

export const SalesInvoiceRevisionPayloadSchema = z.object({
  invoiceDate: DateStr,
  dueDate: DateStr.optional().nullable(),
  customerId: z.string().uuid(),
  branchId: z.string().uuid(),
  salesRepresentativeId: z.string().uuid().optional().nullable(),
  taxRate: PctStr.optional().default("0"),
  notes: z.string().max(1000).optional().nullable(),
  lines: z.array(SalesInvoiceRevisionLineSchema).min(1),
});
export type SalesInvoiceRevisionPayload = z.infer<typeof SalesInvoiceRevisionPayloadSchema>;

export const PreviewSalesInvoiceRevisionSchema = z.object({
  expectedRevisionNumber: z.number().int().min(1),
  reason: Reason,
  idempotencyKey: IdempotencyKey.optional(),
  payload: SalesInvoiceRevisionPayloadSchema,
});
export type PreviewSalesInvoiceRevision = z.infer<typeof PreviewSalesInvoiceRevisionSchema>;

export const ExecuteSalesInvoiceRevisionSchema = z.object({
  expectedRevisionNumber: z.number().int().min(1),
  previewFingerprint: Fingerprint,
  reason: Reason,
  idempotencyKey: IdempotencyKey,
  /** Warning codes the actor explicitly accepted in the comparison screen. */
  acknowledgedWarnings: z.array(z.string().max(80)).max(50).optional().default([]),
  payload: SalesInvoiceRevisionPayloadSchema,
});
export type ExecuteSalesInvoiceRevision = z.infer<typeof ExecuteSalesInvoiceRevisionSchema>;

// ── Purchase ──────────────────────────────────────────────────────────────

export const PurchaseInvoiceRevisionLineSchema = z.object({
  lineId: z.string().uuid().optional(),
  productVariantId: z.string().uuid(),
  boardsQuantity: QtyStr,
  lengthM: QtyStr.optional(),
  widthM: QtyStr.optional(),
  heightM: QtyStr.optional(),
  colorCode: z.string().max(20).optional().nullable(),
  unitLabel: z.string().max(30).optional().nullable(),
  /** Per metre, ex-tax. */
  unitPrice: MoneyStr,
  taxRate: PctStr.optional().default("0"),
  isFree: z.boolean().optional().default(false),
});
export type PurchaseInvoiceRevisionLine = z.infer<typeof PurchaseInvoiceRevisionLineSchema>;

export const PurchaseInvoiceRevisionPayloadSchema = z.object({
  invoiceDate: DateStr,
  dueDate: DateStr.optional().nullable(),
  supplierId: z.string().uuid(),
  branchId: z.string().uuid(),
  basedOn: z.string().max(300).optional().nullable(),
  docDirection: z.string().max(100).optional().nullable(),
  customsNumber: z.string().max(100).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  lines: z.array(PurchaseInvoiceRevisionLineSchema).min(1),
});
export type PurchaseInvoiceRevisionPayload = z.infer<typeof PurchaseInvoiceRevisionPayloadSchema>;

export const PreviewPurchaseInvoiceRevisionSchema = z.object({
  expectedRevisionNumber: z.number().int().min(1),
  reason: Reason,
  idempotencyKey: IdempotencyKey.optional(),
  payload: PurchaseInvoiceRevisionPayloadSchema,
});
export type PreviewPurchaseInvoiceRevision = z.infer<typeof PreviewPurchaseInvoiceRevisionSchema>;

export const ExecutePurchaseInvoiceRevisionSchema = z.object({
  expectedRevisionNumber: z.number().int().min(1),
  previewFingerprint: Fingerprint,
  reason: Reason,
  idempotencyKey: IdempotencyKey,
  acknowledgedWarnings: z.array(z.string().max(80)).max(50).optional().default([]),
  payload: PurchaseInvoiceRevisionPayloadSchema,
});
export type ExecutePurchaseInvoiceRevision = z.infer<typeof ExecutePurchaseInvoiceRevisionSchema>;

// ── Response shapes (documentation + web typing; not runtime-validated) ────

export interface RevisionIssue {
  /** Stable machine code, e.g. "insufficient_stock_in_revised_branch". */
  code: string;
  /** Arabic, user-facing. */
  messageAr: string;
  /** Optional structured context — never raw SQL or Prisma text. */
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
  /** Confirmed returned boards linked to this original line. */
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

export interface RevisionJournalPreviewLine {
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  debit: string;
  credit: string;
  partyType: "CUSTOMER" | "SUPPLIER" | null;
  partyId: string | null;
  branchId: string | null;
  note: string | null;
}

export interface RevisionJournalPreview {
  kind: "REVERSAL" | "REPLACEMENT" | "REVERSAL_COGS" | "REPLACEMENT_COGS" | "VALUATION_ADJUSTMENT";
  descriptionAr: string;
  postingDate: string;
  totalDebit: string;
  totalCredit: string;
  lines: RevisionJournalPreviewLine[];
}

export interface RevisionValuationVariant {
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
  /** Movements considered by the replay for this variant. */
  replayEventCount: number;
  /** Forward-replaying the unrevised facts reproduced today's stored state. */
  replayReproducedCurrentState: boolean;
}

export interface RevisionValuation {
  replayRequired: boolean;
  /** Plain-language justification, always present — including when false. */
  reasonAr: string;
  /** Earliest effective timestamp the replay starts from (ISO), null if none. */
  replayStartAt: string | null;
  variants: RevisionValuationVariant[];
  totalInventoryValueDelta: string;
  totalCogsDelta: string;
}

export interface RevisionPartyImpact {
  partyType: "CUSTOMER" | "SUPPLIER";
  partyId: string;
  partyNameAr: string;
  /** Ledger movement this revision causes for the party, signed. */
  balanceDelta: string;
  /** Voucher money already applied to this invoice — never altered. */
  allocatedAmount: string;
  /** Revised invoice total minus what is already applied. */
  outstandingAfter: string;
  /** Positive when the party ends up in credit/advance because of the revision. */
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
  header: { field: string; before: string | null; after: string | null }[];
  currentLines: Record<string, string | null>[];
  revisedLines: Record<string, string | null>[];
  lineDiffs: RevisionLineDiff[];
  currentTotals: Record<string, string>;
  revisedTotals: Record<string, string>;
  totalDelta: string;
  stockReversal: RevisionStockEffect[];
  stockApplication: RevisionStockEffect[];
  branchQuantityDelta: RevisionStockEffect[];
  linkedReturns: { returnId: string; returnNumber: string; status: string; date: string; boards: string }[];
  linkedVouchers: { voucherId: string; voucherNumber: string; date: string; amount: string; allocated: string }[];
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
  /** Proof that the calculation wrote nothing. */
  committedChanges: 0;
}

export interface InvoiceRevisionResult {
  invoice: unknown;
  revision: {
    id: string;
    revisionNumber: number;
    previousRevisionNumber: number;
    reason: string;
    status: string;
    documentDate: string;
    postingDate: string;
    crossesClosedPeriod: boolean;
    revisedBy: string;
    revisedByName: string | null;
    createdAt: string;
  };
  reversalJournalEntryIds: string[];
  replacementJournalEntryIds: string[];
  valuationJournalEntryIds: string[];
  reversalMovementIds: string[];
  replacementMovementIds: string[];
  reversalPartyTransactionIds: string[];
  replacementPartyTransactionIds: string[];
  valuation: RevisionValuation;
  /** true when this request replayed an earlier identical one and wrote nothing. */
  idempotentReplay: boolean;
}
