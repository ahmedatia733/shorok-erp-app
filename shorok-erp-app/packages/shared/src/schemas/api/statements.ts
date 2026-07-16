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
});
export type ConsolidatedStatementQuery = z.infer<typeof ConsolidatedStatementQuerySchema>;
