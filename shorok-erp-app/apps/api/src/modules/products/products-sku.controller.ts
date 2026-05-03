import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import {
  CreateSkuRequestSchema,
  UpdateSkuRequestSchema,
  type CreateSkuRequest,
  type UpdateSkuRequest,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("products/skus")
export class ProductsSkuController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Query("active") active?: string) {
    return this.prisma.productSku.findMany({
      where: active === "false" ? undefined : { active: true },
      orderBy: { code: "asc" },
    });
  }

  @Post()
  @Roles("OWNER")
  async create(
    @Body(new ZodValidationPipe(CreateSkuRequestSchema)) body: CreateSkuRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const sku = await tx.productSku.create({ data: body });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "product_sku",
        entityId: sku.id,
        afterSnapshot: sku,
        summaryAr: `أنشأ المالك الصنف «${sku.colorNameAr}» (${sku.code}).`,
        summaryEn: `Owner created SKU "${sku.colorNameEn}" (${sku.code}).`,
      });
      return sku;
    });
  }

  @Patch(":id")
  @Roles("OWNER")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateSkuRequestSchema)) body: UpdateSkuRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.productSku.findUnique({ where: { id } });
      if (!before) throw new NotFoundError({ id });
      const after = await tx.productSku.update({ where: { id }, data: body });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "product_sku",
        entityId: id,
        beforeSnapshot: before,
        afterSnapshot: after,
        summaryAr: `حدّث المالك بيانات الصنف «${after.colorNameAr}».`,
        summaryEn: `Owner updated SKU "${after.colorNameEn}".`,
      });
      return after;
    });
  }
}
