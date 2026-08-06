import { z } from "zod";

/**
 * Inventory transfer (P9) — moving complete boards of an exact ProductVariant
 * between two branches of the same company.
 *
 * The user enters ONE number per line: how many boards. Everything else —
 * metres, cost, value — is derived by the server from the variant's own board
 * size and the shared weighted-average cost. There is deliberately no field
 * for metres or cost in any request schema, so a client cannot supply one even
 * by accident.
 */

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Whole boards only: no decimal point is even accepted. */
const BoardCount = z.string().regex(/^[1-9]\d{0,5}$/, {
  message: "board quantity must be a whole number of at least 1",
});
const IdempotencyKey = z.string().min(8).max(120).regex(/^[A-Za-z0-9:_.-]+$/);
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);

export const InventoryTransferStatusEnum = z.enum(["DRAFT", "CONFIRMED", "CANCELLED"]);
export type InventoryTransferStatus = z.infer<typeof InventoryTransferStatusEnum>;

export const InventoryTransferLineInputSchema = z.object({
  productVariantId: z.string().uuid(),
  /** Number of COMPLETE boards. The server multiplies by the variant's size. */
  boardQuantity: BoardCount,
});
export type InventoryTransferLineInput = z.infer<typeof InventoryTransferLineInputSchema>;

const linesUnique = (lines: Array<{ productVariantId: string }>) =>
  new Set(lines.map((l) => l.productVariantId)).size === lines.length;

const distinctBranches = (v: { sourceBranchId: string; destinationBranchId: string }) =>
  v.sourceBranchId !== v.destinationBranchId;

export const CreateInventoryTransferSchema = z
  .object({
    transferDate: DateStr,
    sourceBranchId: z.string().uuid(),
    destinationBranchId: z.string().uuid(),
    purpose: z.string().max(300).optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
    lines: z
      .array(InventoryTransferLineInputSchema)
      .min(1)
      .refine(linesUnique, { message: "duplicate productVariantId in lines" }),
  })
  .refine(distinctBranches, {
    message: "source and destination must be different branches",
    path: ["destinationBranchId"],
  });
export type CreateInventoryTransfer = z.infer<typeof CreateInventoryTransferSchema>;

export const UpdateInventoryTransferSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    transferDate: DateStr,
    sourceBranchId: z.string().uuid(),
    destinationBranchId: z.string().uuid(),
    purpose: z.string().max(300).optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
    lines: z
      .array(InventoryTransferLineInputSchema)
      .min(1)
      .refine(linesUnique, { message: "duplicate productVariantId in lines" }),
  })
  .refine(distinctBranches, {
    message: "source and destination must be different branches",
    path: ["destinationBranchId"],
  });
export type UpdateInventoryTransfer = z.infer<typeof UpdateInventoryTransferSchema>;

/** Preview from a payload that has not been saved yet. Writes nothing. */
export const PreviewInventoryTransferSchema = CreateInventoryTransferSchema;
export type PreviewInventoryTransfer = z.infer<typeof PreviewInventoryTransferSchema>;

export const ConfirmInventoryTransferSchema = z.object({
  expectedVersion: z.number().int().min(1),
  previewFingerprint: Fingerprint,
  idempotencyKey: IdempotencyKey,
});
export type ConfirmInventoryTransfer = z.infer<typeof ConfirmInventoryTransferSchema>;

export const CancelInventoryTransferSchema = z.object({
  expectedVersion: z.number().int().min(1),
  previewFingerprint: Fingerprint,
  idempotencyKey: IdempotencyKey,
  reason: z.string().trim().min(3).max(500),
});
export type CancelInventoryTransfer = z.infer<typeof CancelInventoryTransferSchema>;

export const InventoryTransferQuerySchema = z.object({
  status: InventoryTransferStatusEnum.optional(),
  sourceBranchId: z.string().uuid().optional(),
  destinationBranchId: z.string().uuid().optional(),
  productVariantId: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
  from: DateStr.optional(),
  to: DateStr.optional(),
  cursor: z.string().uuid().optional().nullable(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type InventoryTransferQuery = z.infer<typeof InventoryTransferQuerySchema>;

// ── Response shapes (documentation + web typing) ──────────────────────────

export interface InventoryTransferIssue {
  code: string;
  messageAr: string;
  context?: Record<string, string | number | null>;
}

export interface InventoryTransferPreviewLine {
  productVariantId: string;
  skuCode: string;
  productNameAr: string;
  productNameEn: string | null;
  boardSizeMeters: string;
  boardQuantity: string;
  meterQuantity: string;
  costPerMeter: string;
  totalValue: string;
  sourceBoardsBefore: string;
  sourceMetersBefore: string;
  sourceBoardsAfter: string;
  sourceMetersAfter: string;
  destinationBoardsBefore: string;
  destinationMetersBefore: string;
  destinationBoardsAfter: string;
  destinationMetersAfter: string;
  /** Global figures for this variant — identical before and after, by design. */
  globalBoardsBefore: string;
  globalBoardsAfter: string;
  globalMetersBefore: string;
  globalMetersAfter: string;
  globalValueBefore: string;
  globalValueAfter: string;
  blocking: InventoryTransferIssue[];
}

export interface InventoryTransferPreview {
  transferId: string | null;
  transferNumber: string | null;
  status: InventoryTransferStatus | null;
  operation: "CONFIRM" | "CANCEL";
  transferDate: string;
  sourceBranch: { id: string; nameAr: string };
  destinationBranch: { id: string; nameAr: string };
  lines: InventoryTransferPreviewLine[];
  totals: {
    lineCount: number;
    boards: string;
    meters: string;
    value: string;
    globalBoardsBefore: string;
    globalBoardsAfter: string;
    globalMetersBefore: string;
    globalMetersAfter: string;
    globalValueBefore: string;
    globalValueAfter: string;
  };
  /** Always "NONE" while inventory uses a single shared control account. */
  accountingEffect: "NONE" | "RECLASSIFICATION";
  accountingReasonAr: string;
  blocking: InventoryTransferIssue[];
  warnings: InventoryTransferIssue[];
  previewFingerprint: string;
  /** Proof that computing this preview wrote nothing. */
  committedChanges: 0;
}

// ── Source-stock-driven size options (P10) ────────────────────────────────
//
// After picking a source branch and a base product, the user is shown the
// sizes that ACTUALLY exist in that branch. The badges below are display
// labels only — stock identity stays (Branch, ProductVariant), and a transfer
// is still posted against an exact productVariantId.

export const SourceSizeOptionsQuerySchema = z.object({
  sourceBranchId: z.string().uuid(),
  productSkuId: z.string().uuid(),
});
export type SourceSizeOptionsQuery = z.infer<typeof SourceSizeOptionsQuerySchema>;

/** ك (5.25 m) · ص (4.00 m) · م/خ (anything else genuinely stored). */
export const TransferSizeBadgeEnum = z.enum(["LARGE", "SMALL", "CUSTOM"]);
export type TransferSizeBadge = z.infer<typeof TransferSizeBadgeEnum>;

export interface SourceSizeOption {
  /** The exact variant a transfer line will be posted against. */
  productVariantId: string;
  sizeBadge: TransferSizeBadge;
  sizeBadgeAr: string;
  sizeBadgeEn: string;
  /** «5.25 م» — dimensions only. Never carries an invented second dimension. */
  dimensionsLabelAr: string;
  dimensionsLabelEn: string;
  boardSizeMeters: string;
  /** Always null from a ProductVariant: only one dimension is stored. */
  widthMeters: string | null;
  boardsAvailable: string;
  metersAvailable: string;
  enabled: boolean;
  disabledReason: string | null;
  disabledReasonAr: string | null;
  variantCode: string;
  variantDisplayNameAr: string;
  variantDisplayNameEn: string | null;
}

export interface SourceSizeOptionsResponse {
  sourceBranchId: string;
  sourceBranchNameAr: string;
  productSkuId: string;
  productCode: string;
  productNameAr: string;
  productNameEn: string | null;
  options: SourceSizeOption[];
  /** Proof this read changed nothing. */
  committedChanges: 0;
}
