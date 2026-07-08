import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import {
  CreatePeriodSchema,
  ReopenPeriodSchema,
  type CreatePeriod,
  type ReopenPeriod,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

/**
 * Financial periods (Phase 2). PostingEngine rejects entries whose entry_date
 * falls in a non-OPEN or missing period. Existing legacy posting controllers
 * are NOT globally period-gated in Phase 2 — only the engine enforces periods.
 * Roles per common/permissions.ts: create/close = ACCOUNTANT(+OWNER),
 * reopen = OWNER only.
 */
@Controller("settings/periods")
export class PeriodsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles("ACCOUNTANT")
  list() {
    return this.prisma.financialPeriod.findMany({
      orderBy: [{ year: "desc" }, { month: "desc" }],
    });
  }

  @Post()
  @Roles("ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreatePeriodSchema)) body: CreatePeriod,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const existing = await this.prisma.financialPeriod.findUnique({
      where: { year_month: { year: body.year, month: body.month } },
    });
    if (existing) throw new ValidationError({ reason: "period_exists", year: body.year, month: body.month });

    return this.prisma.runInTransaction(async (tx) => {
      const period = await tx.financialPeriod.create({
        data: { year: body.year, month: body.month, status: "OPEN" },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "financial_period",
        entityId: period.id,
        afterSnapshot: { year: body.year, month: body.month, status: "OPEN" },
        summaryAr: `${user.name} فتح الفترة المحاسبية ${body.month}/${body.year}`,
        summaryEn: `${user.name} opened financial period ${body.month}/${body.year}`,
      });
      return period;
    });
  }

  @Post(":id/close")
  @Roles("ACCOUNTANT")
  async close(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const period = await this.prisma.financialPeriod.findUnique({ where: { id } });
    if (!period) throw new NotFoundError({ id });
    if (period.status === "CLOSED") throw new ValidationError({ reason: "period_already_closed" });

    return this.prisma.runInTransaction(async (tx) => {
      const updated = await tx.financialPeriod.update({
        where: { id },
        data: { status: "CLOSED", closedBy: user.id, closedAt: new Date() },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "financial_period",
        entityId: id,
        beforeSnapshot: { status: "OPEN" },
        afterSnapshot: { status: "CLOSED" },
        summaryAr: `${user.name} أقفل الفترة المحاسبية ${period.month}/${period.year}`,
        summaryEn: `${user.name} closed financial period ${period.month}/${period.year}`,
      });
      return updated;
    });
  }

  @Post(":id/reopen")
  @Roles("OWNER")
  async reopen(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ReopenPeriodSchema)) body: ReopenPeriod,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const period = await this.prisma.financialPeriod.findUnique({ where: { id } });
    if (!period) throw new NotFoundError({ id });
    if (period.status === "OPEN") throw new ValidationError({ reason: "period_already_open" });

    return this.prisma.runInTransaction(async (tx) => {
      const updated = await tx.financialPeriod.update({
        where: { id },
        data: { status: "OPEN", reopenedBy: user.id, reopenedAt: new Date(), reopenReason: body.reason },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "financial_period",
        entityId: id,
        beforeSnapshot: { status: "CLOSED" },
        afterSnapshot: { status: "OPEN", reason: body.reason },
        summaryAr: `${user.name} أعاد فتح الفترة ${period.month}/${period.year} — ${body.reason}`,
        summaryEn: `${user.name} reopened period ${period.month}/${period.year} — ${body.reason}`,
      });
      return updated;
    });
  }
}
