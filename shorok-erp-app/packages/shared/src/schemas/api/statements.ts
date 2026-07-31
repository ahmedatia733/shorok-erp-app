import { z } from "zod";
import { ACCOUNT_CATEGORIES } from "../../account-categories";

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Derived from the shared category list, so an unknown category is rejected as a
// bad request and the valid set can never drift from the selector's options.
const CategoryId = z.enum(
  ACCOUNT_CATEGORIES.map((c) => c.id) as [string, ...string[]],
);

/**
 * Query for the unified Account Statement page.
 *
 * `entityId` omitted or "all" → consolidated statement for the whole category;
 * a uuid → the statement for that single account / customer / supplier.
 */
/**
 * Balance-side filter for the aggregated party (customer/supplier) statement,
 * classifying each party by its FINAL balance for the period:
 *   ALL    → every party (default; unchanged behaviour)
 *   DEBIT  → only parties whose final balance is a net debit  (customer owes us)
 *   CREDIT → only parties whose final balance is a net credit (we owe them)
 * Zero-balance parties are excluded from DEBIT and CREDIT. Ignored for a specific
 * party and for GL-account categories.
 */
export const BalanceSideEnum = z.enum(["ALL", "DEBIT", "CREDIT"]);
export type BalanceSide = z.infer<typeof BalanceSideEnum>;

export const ConsolidatedStatementQuerySchema = z.object({
  category: CategoryId,
  entityId: z.union([z.literal("all"), z.string().uuid()]).optional(),
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  /** Show accounts with no opening, no movement and a zero ending balance. */
  includeZero: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true"),
  /** Filter the aggregated party statement by final-balance side. Default ALL. */
  balanceSide: BalanceSideEnum.optional().default("ALL"),
});
export type ConsolidatedStatementQuery = z.infer<typeof ConsolidatedStatementQuerySchema>;
