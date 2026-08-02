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
  /**
   * `OPENING_BALANCE` rows come from the approved opening source and carry a
   * real balance; they are what the expected customer totals reconcile against.
   *
   * `MASTER_ONLY` rows are genuine legacy customers with no approved
   * replacement. They are preserved as customer records at **zero** balance so
   * no history is lost, and they are deliberately excluded from the opening
   * totals — otherwise preserving a customer would silently change the AR
   * figures the owner approved.
   */
  openingBalanceScope: z
    .enum(["OPENING_BALANCE", "MASTER_ONLY"])
    .optional()
    .default("OPENING_BALANCE"),
}).strict();

export const productRowSchema = rowBase.extend({
  entity: z.literal("PRODUCT"),
  /** Codes are STRINGS. A numeric-looking code must never be cast to a number. */
  approvedCode: z.string().min(1).max(60),
  /**
   * A product has NO separate name column in this model. `ProductSku` carries
   * code + colorNameAr/colorNameEn, and the UI renders a product as
   * `{code} · {colorName}` — so the approved COLOUR *is* the product's name.
   * Both columns are NOT NULL, so a colour is always required.
   */
  approvedColorAr: z.string().min(1).max(120),
  approvedColorEn: z.string().min(1).max(120),
  /**
   * Descriptive text from the source document, kept as AUDIT EVIDENCE ONLY.
   * It is deliberately NOT persisted anywhere — there is no column for it —
   * and the field name says so, rather than implying it was imported.
   */
  sourceDescriptiveName: z.string().max(200).optional().default(""),
  approvedCategory: z.enum(["NORMAL", "SPECIAL"]).default("NORMAL"),
  sizeMetersPerBoard: QTY.positive(),
  defaultSalePricePerMeter: MONEY.nonnegative().default(0),
  defaultPurchasePricePerMeter: MONEY.nonnegative().default(0),
}).strict();

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
}).strict();

export const glRowSchema = rowBase.extend({
  entity: z.literal("GL"),
  accountCode: z.string().min(1).max(40),
  debit: MONEY.nonnegative().default(0),
  credit: MONEY.nonnegative().default(0),
}).strict();

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

    /**
     * The import binds to ONE approved branch and ONE approved actor. The CLI
     * must never fall back to "the first active branch" or "the first OWNER" —
     * that would silently import into whichever row happened to be created
     * first.
     */
    branch: z.object({
      approvedBranchId: z.string().uuid(),
      approvedKey: z.string().min(1).max(160),
      approvedNameAr: z.string().min(1).max(200),
    }),
    actor: z.object({
      approvedUserId: z.string().uuid(),
      approvedPhone: z.string().min(3).max(30),
    }),

    sourceFiles: z.array(z.object({ id: z.string().min(1), sha256: SHA256 })).min(1),
    approvedManifestFiles: z
      .array(z.object({ id: z.string().min(1), sha256: SHA256 }))
      .default([]),

    datePolicy: z.enum(["SWAP_DAY_MONTH_ON_DATE_CELLS_V1", "NO_CORRECTION"]),
    inventoryValueBasis: z.enum(["PRINTED_PDF_TOTAL", "CANONICAL_RECOMPUTED"]),
    reversalPolicyReference: z.string().max(40).default("A_PLUS_D"),
    balancingPolicy: z.enum([
      "REQUIRE_FULL_TRIAL_BALANCE",
      "TEMPORARY_OPENING_EQUITY",
      "NO_JOURNAL",
    ]),
    /**
     * Only for TEMPORARY_OPENING_EQUITY. Every field is mandatory under that
     * policy: the balancing line is never calculated or invented — the approver
     * states the account and the exact amount, and the importer verifies that
     * the stated amount is the one that actually balances.
     */
    temporaryOpeningEquity: z
      .object({
        accountCode: z.string().min(1).max(40),
        approvedAmount: MONEY,
        side: z.enum(["DEBIT", "CREDIT"]),
        approver: z.string().min(1).max(120),
        clearanceDeadline: ISO_DATE,
      })
      .optional(),

    approver: z.string().max(120),
    approvalDate: z.string().max(40),
    operator: z.string().max(120),
    approvalEvidenceHash: SHA256.optional(),

    /** Must be 0 for execute. Any non-zero value refuses. */
    unresolvedDecisions: z.number().int().nonnegative(),

    /**
     * The printed PDF grand total is authoritative, but the sum of the
     * per-row valuations can differ from it by a rounding remainder. That
     * remainder is never silently absorbed: it is declared here, approved, and
     * applied to exactly one deterministically chosen row.
     */
    valuationRoundingAdjustment: z
      .object({
        amount: MONEY,
        reason: z.string().min(1).max(120),
        approvedBy: z.string().min(1).max(120),
        approvedAt: ISO_DATE,
      })
      .optional(),

    /**
     * Account codes the opening journal posts to. Resolved against the live
     * chart of accounts by code; a missing code refuses rather than guessing.
     */
    postingAccounts: z
      .object({
        arControlCode: z.string().min(1).max(40),
        inventoryControlCode: z.string().min(1).max(40),
      })
      .optional(),

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
