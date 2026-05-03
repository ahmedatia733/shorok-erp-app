import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { BranchForbiddenError } from "../errors/api-errors";
import type { AuthenticatedUser } from "../types/request-user";

/**
 * Verifies that the authenticated user has access to the branch referenced
 * by the request — looks for `branchId` in route params, query string, or
 * request body (in that order). OWNER bypasses entirely.
 *
 * If no branchId is present, the guard is a no-op and lets the controller
 * decide; this lets us put the guard at the controller level for branch-
 * scoped resources without breaking endpoints that take an optional branch.
 */
@Injectable()
export class BranchScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user) return false;
    if (user.role === "OWNER") return true;

    const branchId = this.extractBranchId(request);
    if (!branchId) return true;

    if (!user.allowedBranches.includes(branchId)) {
      throw new BranchForbiddenError({ branchId });
    }
    return true;
  }

  private extractBranchId(request: {
    params?: Record<string, string>;
    query?: Record<string, string | string[] | undefined>;
    body?: Record<string, unknown>;
  }): string | null {
    const fromParams = request.params?.branchId;
    if (fromParams) return fromParams;

    const fromQuery = request.query?.branchId;
    if (typeof fromQuery === "string") return fromQuery;

    const fromBody = request.body?.branchId;
    if (typeof fromBody === "string") return fromBody;

    return null;
  }
}
