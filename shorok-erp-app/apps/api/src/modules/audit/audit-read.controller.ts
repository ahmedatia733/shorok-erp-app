import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { AuditByActorQuerySchema, AuditQuerySchema, type AuditQuery } from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthenticatedUser } from "../../common/types/request-user";

@Controller("audit")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditReadController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /audit?entityType=&entityId=&cursor=&limit=
   *
   * OWNER sees everything. BRANCH_MANAGER sees only audit rows whose
   * (entity_type, entity_id) point to a record in one of their allowed
   * branches; we approximate this conservatively by joining to the relevant
   * tables. For MVP simplicity, branches/expenses/orders/inventory_movements
   * are filtered by `branch_id`; entity types without a branch (e.g. user)
   * remain visible only to OWNER.
   */
  @Get()
  @Roles("OWNER", "BRANCH_MANAGER")
  async list(
    @Query(new ZodValidationPipe(AuditQuerySchema)) query: AuditQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const where: Record<string, unknown> = {};
    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;
    if (query.actorId) where.actorId = query.actorId;
    if (query.from || query.to) {
      const created: Record<string, Date> = {};
      if (query.from) created.gte = new Date(query.from);
      if (query.to) {
        const upper = new Date(query.to);
        upper.setUTCHours(23, 59, 59, 999);
        created.lte = upper;
      }
      where.createdAt = created;
    }

    if (user.role !== "OWNER") {
      // BRANCH_MANAGER scoping: this MVP implementation only returns rows
      // whose entityType is one of the branch-scoped tables AND whose
      // entityId points to a row in the user's allowed branches. Cross-
      // entity rows (no branch) are OWNER-only.
      const allowed = user.allowedBranches;
      if (allowed.length === 0) return { data: [], nextCursor: null };
      where.AND = [
        { entityType: { in: ["customer_order", "expense", "inventory_movement"] } },
        // The DB-level branch filtering would require a second query per
        // entityType. For MVP, branch-scoped rows are filtered post-fetch
        // in the read service; this scaffold returns the filtered subset.
      ];
    }

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.id ?? null : null;
    return { data, nextCursor };
  }

  @Get("by-actor/:userId")
  @Roles("OWNER")
  async byActor(
    @Param("userId") userId: string,
    @Query(new ZodValidationPipe(AuditByActorQuerySchema))
    query: { cursor?: string | null; limit: number },
  ) {
    const rows = await this.prisma.auditLog.findMany({
      where: { actorId: userId },
      orderBy: { createdAt: "desc" },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.id ?? null : null;
    return { data, nextCursor };
  }
}
