import { Body, Controller, Get, Patch } from "@nestjs/common";
import { z } from "zod";
import { DecimalStringSchema } from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";

const UpdateSystemSettingsSchema = z.object({
  defaultPriceOverrideTolerancePercent: DecimalStringSchema.optional(),
  lowStockThresholdBoards: DecimalStringSchema.optional(),
});

@Controller("system-settings")
export class SystemSettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  get() {
    return this.prisma.systemSettings.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });
  }

  @Patch()
  @Roles("OWNER")
  async update(
    @Body(new ZodValidationPipe(UpdateSystemSettingsSchema))
    body: z.infer<typeof UpdateSystemSettingsSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.systemSettings.findUnique({ where: { id: 1 } });
      const after = await tx.systemSettings.upsert({
        where: { id: 1 },
        create: { id: 1, ...body },
        update: body,
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "system_settings",
        entityId: null,
        beforeSnapshot: before,
        afterSnapshot: after,
        summaryAr: `حدّث المالك الإعدادات العامة للنظام.`,
        summaryEn: `Owner updated system settings.`,
      });
      return after;
    });
  }
}
