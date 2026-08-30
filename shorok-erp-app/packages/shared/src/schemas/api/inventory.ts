import { z } from "zod";
import { MovementTypeEnum } from "../../enums";
import { DecimalStringSchema, IsoDateTimeSchema, UuidSchema } from "../primitives";

export const ReceiptRequestSchema = z.object({
  branchId: UuidSchema,
  productVariantId: UuidSchema,
  boardsQuantity: DecimalStringSchema,
  note: z.string().max(500).optional(),
});
export type ReceiptRequest = z.infer<typeof ReceiptRequestSchema>;

/**
 * A stock adjustment moves whole boards.
 *
 * `DecimalStringSchema` would accept "0.5", and the form previously offered a
 * 0.01 step, so half a board could be submitted — a quantity the warehouse
 * cannot actually hold. Production has never recorded a fractional movement of
 * any kind, so this states the rule the business already follows rather than
 * imposing a new one. The sign is what makes it an increase or a decrease.
 */
export const BoardDeltaSchema = z
  .string()
  .trim()
  .regex(/^-?[1-9]\d{0,5}$/, { message: "must be a whole, non-zero number of boards" });

export const AdjustmentRequestSchema = z.object({
  branchId: UuidSchema,
  productVariantId: UuidSchema,
  boardsDelta: BoardDeltaSchema,
  note: z.string().trim().min(1).max(500),
});
export type AdjustmentRequest = z.infer<typeof AdjustmentRequestSchema>;

export const CountLineSchema = z.object({
  productVariantId: UuidSchema,
  countedBoards: DecimalStringSchema,
});
export type CountLine = z.infer<typeof CountLineSchema>;

export const CountRequestSchema = z.object({
  branchId: UuidSchema,
  lines: z.array(CountLineSchema).min(1),
});
export type CountRequest = z.infer<typeof CountRequestSchema>;

export const InventoryMovementsQuerySchema = z.object({
  branchId: UuidSchema.optional(),
  productVariantId: UuidSchema.optional(),
  movementType: MovementTypeEnum.optional(),
  referenceId: z.string().uuid().optional(),
  referenceType: z.string().max(50).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  /**
   * Free text over product code, product name and the movement note, plus the
   * board-size vocabulary (ك / ص / م ق and measurements). Parsed server-side so
   * it filters the whole history rather than the page already downloaded.
   */
  search: z.string().max(120).optional(),
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type InventoryMovementsQuery = z.infer<typeof InventoryMovementsQuerySchema>;


// ── Branch stock availability (read-only pickers) ─────────────────────────

export const BranchStockQuerySchema = z.object({ branchId: UuidSchema });
export type BranchStockQuery = z.infer<typeof BranchStockQuerySchema>;

export const BranchStockSizesQuerySchema = z.object({
  branchId: UuidSchema,
  productSkuId: UuidSchema,
});
export type BranchStockSizesQuery = z.infer<typeof BranchStockSizesQuerySchema>;

export interface BranchStockProduct {
  productSkuId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  availableSizeCount: number;
}

export interface BranchStockProductsResponse {
  branchId: string;
  branchNameAr: string;
  products: BranchStockProduct[];
  committedChanges: 0;
}

export interface BranchStockSize {
  /** The exact variant an adjustment will be posted against. */
  productVariantId: string;
  sizeBadge: "LARGE" | "SMALL" | "CUSTOM";
  sizeBadgeAr: string;
  dimensionsLabelAr: string;
  boardSizeMeters: string;
  boardsOnHand: string;
  metersOnHand: string;
  /** Strictly "this branch holds some of this exact size right now". */
  hasStock: boolean;
  /**
   * Whether a settlement may be posted against this size at all.
   *
   * Wider than `hasStock` on purpose: a size sitting at zero is still
   * adjustable upwards, because "the count found two boards the system does not
   * know about" is precisely what a settlement records. What is *not* adjustable
   * is a discontinued size or a balance whose boards and metres disagree — the
   * first should not gain stock, and the second needs a data repair rather than
   * a settlement.
   */
  adjustable: boolean;
  blockedReason: string | null;
  blockedReasonAr: string | null;
}

export interface BranchStockSizesResponse {
  branchId: string;
  branchNameAr: string;
  productSkuId: string;
  productCode: string;
  productNameAr: string;
  sizes: BranchStockSize[];
  committedChanges: 0;
}
