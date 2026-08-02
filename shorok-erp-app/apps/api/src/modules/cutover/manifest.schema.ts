import { z } from "zod";

/**
 * The approved cutover manifest. This is the ONLY execution input — the
 * importer never re-parses the source workbook or PDF at import time, because
 * a human approved these values, not the raw files.
 *
 * Every expected total lives here rather than as a constant in source code, so
 * committed code carries no private figure and a revised approval automatically
 * revises what the importer asserts.
 */

const MONEY = z.number().finite();
const QTY = z.number().finite();
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/i, "expected a sha256 hex digest");

export const APPROVAL_STATUS = ["APPROVED", "REVIEW_REQUIRED", "BLOCKED", "EXCLUDED"] as const;

const rowBase = z.object({
  decisionId: z.string().min(1).max(60),
  sourceFileId: z.string().min(1).max(80),
  sourceSheetOrPage: z.string().min(1).max(80),
  sourceRow: z.union([z.number().int(), z.string().max(20)]),
  sourceKey: z.string().min(1).max(160),
  normalizedApprovedKey: z.string().min(1).max(160),
  approvalStatus: z.enum(APPROVAL_STATUS),
  approvedBy: z.string().max(120).optional().default(""),
  approvedAt: z.string().max(40).optional().default(""),
  exclusionReason: z.string().max(300).optional().default(""),
});

export const customerRowSchema = rowBase.extend({
  entity: z.literal("CUSTOMER"),
  approvedName: z.string().min(1).max(200),
  /** Customer.code is VarChar(20) and NOT NULL in the schema. */
  approvedCode: z.string().min(1).max(20),
  side: z.enum(["DEBIT", "CREDIT"]),
  sourceAmount: MONEY,
  approvedAmount: MONEY.nonnegative(),
});

export const productRowSchema = rowBase.extend({
  entity: z.literal("PRODUCT"),
  /** Codes are STRINGS. A numeric-looking code must never be cast to a number. */
  approvedCode: z.string().min(1).max(60),
  approvedName: z.string().min(1).max(200),
  /** ProductSku.colorName{Ar,En} are NOT NULL, so a colour is always required. */
  approvedColorAr: z.string().min(1).max(120),
  approvedColorEn: z.string().min(1).max(120),
  approvedCategory: z.enum(["NORMAL", "SPECIAL"]).default("NORMAL"),
  sizeMetersPerBoard: QTY.positive(),
  defaultSalePricePerMeter: MONEY.nonnegative().default(0),
  defaultPurchasePricePerMeter: MONEY.nonnegative().default(0),
});

export const inventoryRowSchema = rowBase.extend({
  entity: z.literal("INVENTORY"),
  approvedCode: z.string().min(1).max(60),
  sizeMetersPerBoard: QTY.positive(),
  boards: QTY.nonnegative(),
  /** Must equal boards × size. The printed, rounded meters column is never used. */
  canonicalMeters: QTY.nonnegative(),
  pricePerMeter: MONEY.nonnegative(),
  rowValue: MONEY.nonnegative(),
  zeroQuantityTreatment: z
    .enum(["IMPORT_ZERO_QUANTITY_VARIANT", "EXCLUDE"])
    .optional()
    .default("IMPORT_ZERO_QUANTITY_VARIANT"),
});

export const glRowSchema = rowBase.extend({
  entity: z.literal("GL"),
  accountCode: z.string().min(1).max(40),
  debit: MONEY.nonnegative().default(0),
  credit: MONEY.nonnegative().default(0),
});

export const expectedTotalsSchema = z.object({
  customerDebitCount: z.number().int().nonnegative(),
  customerDebitTotal: MONEY,
  customerCreditCount: z.number().int().nonnegative(),
  customerCreditTotal: MONEY,
  customerNetAr: MONEY,
  inventorySourceRowCount: z.number().int().nonnegative(),
  inventoryImportRowCount: z.number().int().nonnegative(),
  inventoryBoards: QTY,
  inventoryMeters: QTY,
  inventoryValue: MONEY,
  openingDebitTotal: MONEY,
  openingCreditTotal: MONEY,
  openingGap: MONEY,
  journalMustPost: z.boolean(),
  fullTrialBalanceRequired: z.boolean(),
});

export const cutoverManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    manifestId: z.string().min(1).max(120),
    cutoverDate: ISO_DATE,
    importScope: z.enum(["FULL_OPENING_IMPORT", "MASTER_AND_STOCK_ONLY", "AUDIT_ONLY"]),

    branch: z.object({
      approvedKey: z.string().min(1).max(160),
      approvedNameAr: z.string().min(1).max(200),
    }),

    sourceFiles: z.array(z.object({ id: z.string().min(1), sha256: SHA256 })).min(1),
    approvedManifestFiles: z
      .array(z.object({ id: z.string().min(1), sha256: SHA256 }))
      .default([]),

    datePolicy: z.enum(["SWAP_DAY_MONTH_ON_DATE_CELLS_V1", "NO_CORRECTION"]),
    inventoryValueBasis: z.enum(["PRINTED_PDF_TOTAL", "CANONICAL_RECOMPUTED"]),
    reversalPolicyReference: z.string().max(40).default("A_PLUS_D"),
    balancingPolicy: z.enum(["REQUIRE_FULL_TRIAL_BALANCE", "TEMPORARY_SUSPENSE", "NO_JOURNAL"]),
    suspenseAccountCode: z.string().max(40).optional().default(""),

    approver: z.string().max(120),
    approvalDate: z.string().max(40),
    operator: z.string().max(120),
    approvalEvidenceHash: SHA256.optional(),

    /** Must be 0 for execute. Any non-zero value refuses. */
    unresolvedDecisions: z.number().int().nonnegative(),

    expectedTotals: expectedTotalsSchema,

    customerRows: z.array(customerRowSchema).default([]),
    productRows: z.array(productRowSchema).default([]),
    inventoryRows: z.array(inventoryRowSchema).default([]),
    openingGlRows: z.array(glRowSchema).default([]),
    excludedRows: z
      .array(
        z.object({
          decisionId: z.string().max(60),
          sourceKey: z.string().max(160),
          reason: z.string().max(300),
        }),
      )
      .default([]),

    /** Non-fatal, deliberately accepted source anomalies. */
    acceptedWarnings: z
      .array(
        z.object({
          code: z.string().max(80),
          decisionId: z.string().max(60),
          note: z.string().max(300),
        }),
      )
      .default([]),

    notes: z.string().max(2000).default(""),
  })
  .strict();

export type CutoverManifest = z.infer<typeof cutoverManifestSchema>;
export type CustomerRow = z.infer<typeof customerRowSchema>;
export type ProductRow = z.infer<typeof productRowSchema>;
export type InventoryRow = z.infer<typeof inventoryRowSchema>;
export type GlRow = z.infer<typeof glRowSchema>;
