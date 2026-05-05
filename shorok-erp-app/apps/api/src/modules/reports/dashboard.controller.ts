import { Controller, ForbiddenException, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { DashboardService } from "./dashboard.service";

const DashboardQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
});
type DashboardQuery = z.infer<typeof DashboardQuerySchema>;

/**
 * T111 — GET /reports/dashboard?branchId=
 *
 * - any authenticated user with access to the branch (BranchScopeGuard
 *   global guard already enforces this via the query string).
 * - OWNER may omit `branchId` for an all-branches view; for non-OWNER
 *   roles, branchId is required.
 */
@Controller("reports")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("dashboard")
  async get(
    @Query(new ZodValidationPipe(DashboardQuerySchema)) query: DashboardQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!query.branchId && user.role !== "OWNER") {
      throw new ForbiddenException({
        code: "branch_required",
        message_ar: "يجب اختيار فرع.",
        message_en: "Select a branch.",
      });
    }
    return this.dashboard.aggregate(query.branchId ?? null);
  }
}
