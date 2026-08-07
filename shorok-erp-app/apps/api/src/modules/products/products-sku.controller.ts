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
    try {
      return await this.updateSku(id, body, user);
    } catch (e) {
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

  /**
   * Edits a product, and — only when explicitly asked — its default purchase
   * price.
   *
   * Everything happens in one transaction: the product row, every eligible
   * size's default, and the audit. A product must never come out of this
   * half-edited, with a new code but old prices or two of five sizes updated.
   *
   * Changing a default purchase price is not a purchase. It says what the next
   * invoice should start from and nothing more: no WAC moves, no stock moves,
   * no journal is written, and every historical invoice keeps the price it was
   * actually agreed at.
   */
  private updateSku(id: string, body: UpdateSkuRequest, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.productSku.findUnique({ where: { id } });
      if (!before) throw new NotFoundError({ id });

      const priceUpdate = body.purchasePriceUpdate;

      const after = await tx.productSku.update({
        where: { id },
        data: {
          ...(body.code !== undefined ? { code: body.code } : {}),
          ...(body.colorNameAr !== undefined ? { colorNameAr: body.colorNameAr } : {}),
          // Only when the caller actually sent one. The edit form asks for the
          // Arabic name alone, and an English name already on the record must
          // not be quietly replaced by it.
          ...(body.colorNameEn !== undefined ? { colorNameEn: body.colorNameEn } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(priceUpdate ? { initialPurchasePricePerMeter: priceUpdate.value } : {}),
        },
      });

      // The eligible set is ACTIVE variants — exactly what GET /products/variants
      // offers a new purchase invoice. Inactive sizes are left alone: they are
      // not on offer, so changing their price would be an edit nobody asked for.
      let variantsUpdated = 0;
      if (priceUpdate) {
        const res = await tx.productVariant.updateMany({
          where: { skuId: id, active: true },
          data: { defaultPurchasePricePerMeter: priceUpdate.value },
        });
        variantsUpdated = res.count;
      }

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "product_sku",
        entityId: id,
        beforeSnapshot: before,
        afterSnapshot: { ...after, variantsRepriced: variantsUpdated },
        summaryAr: priceUpdate
          ? `حدّث ${user.name} بيانات الصنف «${after.colorNameAr}» (${after.code}) وسعر الشراء الافتراضي إلى ${priceUpdate.value} لعدد ${variantsUpdated} مقاس. لم يتغيّر المخزون ولا متوسط التكلفة ولا الفواتير السابقة.`
          : `حدّث ${user.name} بيانات الصنف «${after.colorNameAr}» (${after.code}).`,
        summaryEn: priceUpdate
          ? `${user.name} updated SKU "${after.colorNameEn}" (${after.code}) and set the default purchase price to ${priceUpdate.value} on ${variantsUpdated} size(s). Stock, WAC and past invoices unchanged.`
          : `${user.name} updated SKU "${after.colorNameEn}" (${after.code}).`,
      });

      return { ...after, variantsRepriced: variantsUpdated };
    });
  }
}
