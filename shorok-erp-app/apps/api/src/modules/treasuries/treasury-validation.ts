import { Prisma } from "../../prisma/prisma.service";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";

type Tx = Prisma.TransactionClient;

export interface ResolvedTreasury {
  id: string;
  glAccountId: string;
  branchId: string;
  allowNegativeBalance: boolean;
  active: boolean;
}

/**
 * Shared treasury validation for NEW money documents (receipt vouchers, supplier
 * payments, cash expenses). Given the submitted cash/bank GL account and the
 * document's branch:
 *   - if the GL account maps to a Treasury, it must be ACTIVE, its branch must
 *     equal the document branch, and (non-OWNER) the user must have access to
 *     that branch — otherwise the document is rejected;
 *   - if the GL account maps to NO treasury (a legacy cash account not yet
 *     migrated), the legacy path is preserved: the caller keeps its own
 *     cash/bank-leaf validation and this returns { treasury: null }.
 *
 * A foreign-branch treasury is reported as NOT FOUND (no existence leak), matching
 * the repo-wide policy for direct-id access; a same-user branch mismatch between
 * the treasury and the document is a structured validation error.
 */
export async function resolveOperationalTreasury(
  tx: Tx,
  args: { glAccountId: string; documentBranchId?: string; user: AuthenticatedUser },
): Promise<{ treasury: ResolvedTreasury | null; glAccountId: string }> {
  const treasury = await tx.treasury.findUnique({
    where: { glAccountId: args.glAccountId },
    select: { id: true, glAccountId: true, branchId: true, allowNegativeBalance: true, active: true },
  });
  // Legacy account not mapped to any treasury — preserve existing behaviour.
  if (!treasury) return { treasury: null, glAccountId: args.glAccountId };

  // A non-OWNER submitting a treasury outside their branches learns nothing (404).
  if (args.user.role !== "OWNER" && !args.user.allowedBranches.includes(treasury.branchId)) {
    throw new NotFoundError({ reason: "treasury_not_found", glAccountId: args.glAccountId });
  }
  if (!treasury.active) {
    throw new ValidationError({ reason: "treasury_inactive", treasuryId: treasury.id });
  }
  // Where the document carries a branch, the treasury must belong to it.
  if (args.documentBranchId !== undefined && treasury.branchId !== args.documentBranchId) {
    throw new ValidationError({ reason: "treasury_branch_mismatch", treasuryId: treasury.id, treasuryBranchId: treasury.branchId, documentBranchId: args.documentBranchId });
  }
  return { treasury, glAccountId: treasury.glAccountId };
}

/**
 * Resolve a treasury by its id for a NEW money document. Enforces the same
 * active + branch + access rules and returns the linked GL account + branch so
 * the caller can post lines in the treasury's branch. A foreign treasury is 404.
 */
export async function resolveOperationalTreasuryById(
  tx: Tx,
  args: { treasuryId: string; documentBranchId?: string; user: AuthenticatedUser },
): Promise<ResolvedTreasury> {
  const treasury = await tx.treasury.findUnique({
    where: { id: args.treasuryId },
    select: { id: true, glAccountId: true, branchId: true, allowNegativeBalance: true, active: true },
  });
  if (!treasury) throw new NotFoundError({ treasuryId: args.treasuryId });
  if (args.user.role !== "OWNER" && !args.user.allowedBranches.includes(treasury.branchId)) {
    throw new NotFoundError({ treasuryId: args.treasuryId });
  }
  if (!treasury.active) throw new ValidationError({ reason: "treasury_inactive", treasuryId: treasury.id });
  if (args.documentBranchId !== undefined && treasury.branchId !== args.documentBranchId) {
    throw new ValidationError({ reason: "treasury_branch_mismatch", treasuryId: treasury.id, treasuryBranchId: treasury.branchId, documentBranchId: args.documentBranchId });
  }
  return treasury;
}
