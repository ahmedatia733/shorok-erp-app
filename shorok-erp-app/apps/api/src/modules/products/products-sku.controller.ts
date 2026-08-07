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
import { ConflictError, NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { Prisma, PrismaService } from "../../prisma/prisma.service";

/**
 * Recognises Postgres's unique-violation (Prisma P2002) for a specific column,
 * so a duplicate product code becomes a clear business answer instead of an
 * unhandled server error.
 */
function isUniqueViolation(e: unknown, field: string): boolean {
  const err = e as { code?: string; meta?: { target?: unknown } };
  if (err?.code !== "P2002") return false;
  const target = err.meta?.target;
  const names = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return names.some((n) => n.toLowerCase().includes(field.toLowerCase()));
}

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
    // The Arabic name is the one the business uses; when no English name is
    // supplied it is carried over rather than left blank or invented.
    const data = {
      code: body.code,
      colorNameAr: body.colorNameAr,
      colorNameEn: body.colorNameEn?.trim() || body.colorNameAr,
      category: body.category,
      ...(body.initialPurchasePricePerMeter !== undefined
        ? { initialPurchasePricePerMeter: body.initialPurchasePricePerMeter }
        : {}),
    };

    try {
      return await this.createSku(data, body.firstVariant ?? null, user);
    } catch (e) {
      // The unique index on `code` is what actually decides a race between two
      // simultaneous creates. Whichever loses arrives here, and must be told so
      // in plain Arabic rather than as a 500 carrying a constraint name.
      if (isUniqueViolation(e, "code")) {
        throw new ConflictError("errors.conflict", {
          reason: "PRODUCT_CODE_ALREADY_EXISTS",
          field: "code",
          messageAr: "كود الصنف مستخدم بالفعل.",
          messageEn: "Product code already exists.",
        });
      }
      throw e;
    }
  }

  private createSku(
    data: Prisma.ProductSkuUncheckedCreateInput,
    firstVariant: { sizeMetersPerBoard: string } | null,
    user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const sku = await tx.productSku.create({ data });

      // Only when the caller genuinely supplied a size — the purchase-invoice
      // flow, where a line cannot exist without an exact variant. Created in
      // the SAME transaction, so a product never survives without the size the
      // user asked for, and a size never survives without its product.
      let variant = null;
      if (firstVariant) {
        variant = await tx.productVariant.create({
          data: {
            skuId: sku.id,
            sizeMetersPerBoard: firstVariant.sizeMetersPerBoard,
            defaultPurchasePricePerMeter: data.initialPurchasePricePerMeter ?? "0",
            // Sale prices are entered per line by the seller, never taken from
            // a default, so there is no meaningful figure to invent here.
            defaultSalePricePerMeter: "0",
          },
        });
      }
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
      return variant ? { ...sku, firstVariant: variant } : sku;
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
