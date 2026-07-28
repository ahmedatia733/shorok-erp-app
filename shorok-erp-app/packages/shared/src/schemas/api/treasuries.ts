import { z } from "zod";
import { UuidSchema, IsoDateSchema } from "../primitives";

// Money as a positive 2dp string (no sign). Amounts must be > 0.
const MoneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/, { message: "must be a money string like '12.34'" });
const PositiveMoney = MoneyStr.refine((v) => Number(v) > 0, { message: "must be greater than 0" });

export const TreasuryTypeSchema = z.enum(["CASH", "BANK"]);
export type TreasuryTypeInput = z.infer<typeof TreasuryTypeSchema>;

export const TransferStatusSchema = z.enum(["DRAFT", "CONFIRMED", "CANCELLED"]);
export type TransferStatusInput = z.infer<typeof TransferStatusSchema>;

// ── Create treasury ──────────────────────────────────────────────────
// Either LINK an existing unused cash/bank leaf account (glAccountId), or omit
// it and the API auto-creates a dedicated GL account (treasuryType picks CASH
// vs BANK). code is optional — safely auto-generated when omitted.
export const CreateTreasurySchema = z.object({
  nameAr: z.string().trim().min(1).max(160),
  nameEn: z.string().trim().max(160).optional(),
  code: z.string().trim().min(1).max(30).optional(),
  branchId: UuidSchema,
  currencyCode: z.string().trim().length(3).default("EGP"),
  allowNegativeBalance: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  notes: z.string().trim().max(500).optional(),
  // GL account: link an existing one …
  glAccountId: UuidSchema.optional(),
  // … or auto-create one of this type (used only when glAccountId is omitted).
  treasuryType: TreasuryTypeSchema.default("CASH"),
});
export type CreateTreasury = z.infer<typeof CreateTreasurySchema>;

// ── Update treasury metadata ─────────────────────────────────────────
export const UpdateTreasurySchema = z.object({
  nameAr: z.string().trim().min(1).max(160).optional(),
  nameEn: z.string().trim().max(160).optional().nullable(),
  allowNegativeBalance: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  notes: z.string().trim().max(500).optional().nullable(),
});
export type UpdateTreasury = z.infer<typeof UpdateTreasurySchema>;

export const TreasuryQuerySchema = z.object({
  branchId: UuidSchema.optional(),
  // include inactive treasuries in the list (default: only active in selectors).
  includeInactive: z.coerce.boolean().optional().default(false),
});
export type TreasuryQuery = z.infer<typeof TreasuryQuerySchema>;

// ── Opening balance (posted journal, never an editable balance field) ──
export const TreasuryOpeningBalanceSchema = z.object({
  entryDate: IsoDateSchema,
  amount: PositiveMoney,
  // Counterpart credit account (defaults to the posting profile's opening
  // equity account when omitted).
  counterpartAccountId: UuidSchema.optional(),
  branchId: UuidSchema.optional(),
  reference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(300).optional(),
});
export type TreasuryOpeningBalance = z.infer<typeof TreasuryOpeningBalanceSchema>;

// ── Treasury statement query ─────────────────────────────────────────
export const TreasuryStatementQuerySchema = z.object({
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  branchId: UuidSchema.optional(),
  cursor: UuidSchema.optional().nullable(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
export type TreasuryStatementQuery = z.infer<typeof TreasuryStatementQuerySchema>;

// ── Treasury transfer ────────────────────────────────────────────────
export const CreateTreasuryTransferSchema = z
  .object({
    transferDate: IsoDateSchema,
    sourceTreasuryId: UuidSchema,
    destinationTreasuryId: UuidSchema,
    amount: PositiveMoney,
    reference: z.string().trim().max(100).optional(),
    notes: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.sourceTreasuryId !== v.destinationTreasuryId, {
    message: "source and destination treasuries must differ",
    path: ["destinationTreasuryId"],
  });
export type CreateTreasuryTransfer = z.infer<typeof CreateTreasuryTransferSchema>;

export const UpdateTreasuryTransferSchema = z
  .object({
    transferDate: IsoDateSchema.optional(),
    sourceTreasuryId: UuidSchema.optional(),
    destinationTreasuryId: UuidSchema.optional(),
    amount: PositiveMoney.optional(),
    reference: z.string().trim().max(100).optional().nullable(),
    notes: z.string().trim().max(300).optional().nullable(),
  })
  .refine(
    (v) =>
      !v.sourceTreasuryId ||
      !v.destinationTreasuryId ||
      v.sourceTreasuryId !== v.destinationTreasuryId,
    { message: "source and destination treasuries must differ", path: ["destinationTreasuryId"] },
  );
export type UpdateTreasuryTransfer = z.infer<typeof UpdateTreasuryTransferSchema>;

export const ConfirmTreasuryTransferSchema = z.object({
  acknowledgeNegativeBalance: z.boolean().optional(),
  negativeBalanceReason: z.string().trim().max(300).optional().nullable(),
});
export type ConfirmTreasuryTransfer = z.infer<typeof ConfirmTreasuryTransferSchema>;

export const CancelTreasuryTransferSchema = z.object({
  reason: z.string().trim().min(1).max(300),
});
export type CancelTreasuryTransfer = z.infer<typeof CancelTreasuryTransferSchema>;
