import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import {
  CreateVariantRequestSchema,
  UpdateVariantRequestSchema,
  type CreateVariantRequest,
  type UpdateVariantRequest,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("products/variants")
export class ProductsVariantController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Query("skuId") skuId?: string, @Query("active") active?: string) {
    return this.prisma.productVariant.findMany({
      where: {
        ...(skuId ? { skuId } : {}),
        ...(active === "false" ? {} : { active: true }),
      },
      include: { sku: true },
      orderBy: [{ sku: { code: "asc" } }, { sizeMetersPerBoard: "asc" }],
    });
  }

  @Post()
  @Roles("OWNER")
  async create(
    @Body(new ZodValidationPipe(CreateVariantRequestSchema)) body: CreateVariantRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const sku = await tx.productSku.findUnique({ where: { id: body.skuId } });
      if (!sku) throw new NotFoundError({ skuId: body.skuId });
      const variant = await tx.productVariant.create({ data: body });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "product_variant",
        entityId: variant.id,
        afterSnapshot: variant,
        summaryAr: `أنشأ المالك مقاس ${variant.sizeMetersPerBoard} م للصنف «${sku.colorNameAr}».`,
        summaryEn: `Owner created variant ${variant.sizeMetersPerBoard}m for SKU "${sku.colorNameEn}".`,
      });
      return variant;
    });
  }

  @Patch(":id")
  @Roles("OWNER")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateVariantRequestSchema)) body: UpdateVariantRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.productVariant.findUnique({
        where: { id },
        include: { sku: true },
      });
      if (!before) throw new NotFoundError({ id });
      const after = await tx.productVariant.update({ where: { id }, data: body });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "product_variant",
        entityId: id,
        beforeSnapshot: before,
        afterSnapshot: after,
        summaryAr: `حدّث المالك مقاس الصنف «${before.sku.colorNameAr}».`,
        summaryEn: `Owner updated variant of SKU "${before.sku.colorNameEn}".`,
      });
      return after;
    });
  }
}
