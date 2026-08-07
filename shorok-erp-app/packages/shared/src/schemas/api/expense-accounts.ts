import { z } from "zod";

/**
 * The Expenses management area.
 *
 * An "expense item" here is not a new kind of record — it is a Chart-of-Accounts
 * account whose category is EXPENSE. Everything reported below is read from the
 * existing journal ledger with the same rules the Income Statement uses, so the
 * two can never disagree. Nothing in this contract introduces a second place
 * where an expense amount is stored.
 */

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "expected YYYY-MM-DD" });

/** An account code as the Chart of Accounts stores it. */
export const AccountCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, {
    message: "letters, digits and hyphens only",
  });

export const ExpenseItemStatusEnum = z.enum(["all", "active", "inactive"]);
export type ExpenseItemStatus = z.infer<typeof ExpenseItemStatusEnum>;

/** Shared by the items list and its PDF, so the export cannot drift from the screen. */
export const ExpenseItemsQuerySchema = z.object({
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  search: z.string().trim().max(120).optional(),
  status: ExpenseItemStatusEnum.optional().default("all"),
});
export type ExpenseItemsQuery = z.infer<typeof ExpenseItemsQuerySchema>;

export const ExpenseDashboardQuerySchema = z.object({
  from: DateOnly.optional(),
  to: DateOnly.optional(),
});
export type ExpenseDashboardQuery = z.infer<typeof ExpenseDashboardQuerySchema>;

export const ExpenseMovementsQuerySchema = z.object({
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  /** One expense account, or every one of them when omitted. */
  accountId: z.string().uuid().optional(),
  /** Matches the entry description, the line note, or the entry number. */
  search: z.string().trim().max(120).optional(),
  // Deliberately no branch filter. Expense postings do not set a branch on their
  // journal lines, so filtering by one would quietly return almost nothing while
  // looking authoritative — and an optional `branchId` would additionally turn
  // the global branch guard into a no-op for anyone who omitted it. The branch a
  // line does carry is still shown; see `branchAttributionComplete`.
  minAmount: z.string().trim().regex(/^\d+(\.\d{1,2})?$/).optional(),
  maxAmount: z.string().trim().regex(/^\d+(\.\d{1,2})?$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});
export type ExpenseMovementsQuery = z.infer<typeof ExpenseMovementsQuerySchema>;

export const ExpenseDetailQuerySchema = z.object({
  from: DateOnly.optional(),
  to: DateOnly.optional(),
});
export type ExpenseDetailQuery = z.infer<typeof ExpenseDetailQuerySchema>;

/**
 * Creating an expense item.
 *
 * The user is asked for a name and a code; the category, account type and leaf
 * flag are derived, because they are how the system records "this is an expense
 * account" and are not a decision the person adding «الكهرباء» should have to
 * make. `nameEn` is optional and falls back to the Arabic name so the account
 * always has both, as the Chart of Accounts requires.
 */
export const CreateExpenseAccountSchema = z.object({
  nameAr: z.string().trim().min(1).max(160),
  nameEn: z.string().trim().max(160).optional(),
  code: AccountCodeSchema,
});
export type CreateExpenseAccount = z.infer<typeof CreateExpenseAccountSchema>;

export const UpdateExpenseAccountSchema = z
  .object({
    nameAr: z.string().trim().min(1).max(160).optional(),
    nameEn: z.string().trim().min(1).max(160).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.nameAr !== undefined || v.nameEn !== undefined || v.active !== undefined, {
    message: "nothing to update",
  });
export type UpdateExpenseAccount = z.infer<typeof UpdateExpenseAccountSchema>;

// ── response shapes ────────────────────────────────────────────────────────

export interface ExpenseItem {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  active: boolean;
  /** debit − credit over the selected period, on posted, non-reversed entries. */
  periodAmount: string;
  /** The same measure over all time. */
  totalAmount: string;
  lastMovementDate: string | null;
  periodMovementCount: number;
}

export interface ExpenseItemsResponse {
  from: string;
  to: string;
  items: ExpenseItem[];
  periodTotal: string;
  grandTotal: string;
  activeCount: number;
  inactiveCount: number;
  /** Always 0 — reading expenses never writes. */
  committedChanges: 0;
}

export interface ExpenseMonthPoint {
  /** YYYY-MM */
  month: string;
  amount: string;
}

export interface ExpenseSharePoint {
  accountId: string;
  code: string;
  nameAr: string;
  amount: string;
  /** Share of the period total, 2dp. Empty when the total is zero. */
  percent: string;
}

export interface ExpenseDashboard {
  from: string;
  to: string;
  /** The selected period's total, identical to the Income Statement's. */
  periodTotal: string;
  monthToDateTotal: string;
  todayTotal: string;
  activeItemCount: number;
  topItem: ExpenseSharePoint | null;
  previousPeriodTotal: string;
  /** periodTotal − previousPeriodTotal. */
  changeAmount: string;
  /** Percentage change, or null when the previous period was zero. */
  changePercent: string | null;
  byMonth: ExpenseMonthPoint[];
  byItem: ExpenseSharePoint[];
  /**
   * Mirrors the Income Statement's own flag: expense figures are all-branches,
   * because not every posted journal source carries a branch on its lines.
   */
  branchAttributionComplete: boolean;
  committedChanges: 0;
}

export interface ExpenseCounterAccount {
  accountId: string;
  code: string;
  nameAr: string;
  /** The counter side's amount, positive. */
  amount: string;
}

export interface ExpenseMovement {
  lineId: string;
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  entryType: string;
  reference: string | null;
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  debit: string;
  credit: string;
  /** debit − credit: what this line added to the expense. */
  amount: string;
  note: string | null;
  entryDescription: string;
  /**
   * The other side of the same journal entry. Derived from the entry's own
   * lines — never a guessed "payment method".
   */
  counterAccounts: ExpenseCounterAccount[];
  branchId: string | null;
  branchNameAr: string | null;
}

export interface ExpenseMovementsResponse {
  from: string;
  to: string;
  rows: ExpenseMovement[];
  /** Rows matching the filter, before paging. */
  totalCount: number;
  /** Net total of every matching row, not only the returned page. */
  totalAmount: string;
  limit: number;
  offset: number;
  committedChanges: 0;
}

export interface ExpenseAccountDetail {
  from: string;
  to: string;
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  active: boolean;
  periodAmount: string;
  totalAmount: string;
  lastMovementDate: string | null;
  periodMovementCount: number;
  movements: ExpenseMovement[];
  committedChanges: 0;
}
