import { Controller, Get, Param, Query } from "@nestjs/common";
import { OrdersQuerySchema, type OrdersQuery } from "@shorok/shared";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("orders")
export class OrdersListController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query(new ZodValidationPipe(OrdersQuerySchema)) query: OrdersQuery) {
    const where = {
      branchId: query.branchId,
      ...(query.status ? { status: query.status } : {}),
    };

    const rows = await this.prisma.customerOrder.findMany({
      where,
      orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        productVariant: {
          select: {
            id: true,
            sizeMetersPerBoard: true,
            sku: { select: { code: true, colorNameAr: true, colorNameEn: true } },
          },
        },
        creator: { select: { id: true, name: true } },
      },
    });

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.id ?? null : null;

    return {
      data: data.map((o) => ({
        id: o.id,
        branchId: o.branchId,
        orderDate: o.orderDate,
        customerName: o.customerName,
        productVariantId: o.productVariantId,
        boardsQuantity: o.boardsQuantity.toString(),
        metersQuantity: o.metersQuantity.toString(),
        salePricePerMeter: o.salePricePerMeter.toString(),
        priceOverrideStatus: o.priceOverrideStatus,
        priceApprovedByUserId: o.priceApprovedByUserId,
        priceApprovedAt: o.priceApprovedAt,
        requiredAmount: o.requiredAmount.toString(),
        collectedAmount: o.collectedAmount.toString(),
        remainingAmount: o.remainingAmount.toString(),
        receiverName: o.receiverName,
        status: o.status,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        productVariant: {
          id: o.productVariant.id,
          sizeMetersPerBoard: o.productVariant.sizeMetersPerBoard.toString(),
          sku: o.productVariant.sku,
        },
        creator: o.creator,
      })),
      nextCursor,
    };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const o = await this.prisma.customerOrder.findUnique({
      where: { id },
      include: {
        productVariant: { include: { sku: true } },
        branch: { select: { id: true, nameAr: true, nameEn: true } },
        collections: { orderBy: { collectedAt: "asc" } },
        creator: { select: { id: true, name: true } },
        priceApprover: { select: { id: true, name: true } },
      },
    });
    if (!o) throw new NotFoundError({ id });
    return {
      ...o,
      boardsQuantity: o.boardsQuantity.toString(),
      metersQuantity: o.metersQuantity.toString(),
      salePricePerMeter: o.salePricePerMeter.toString(),
      requiredAmount: o.requiredAmount.toString(),
      collectedAmount: o.collectedAmount.toString(),
      remainingAmount: o.remainingAmount.toString(),
      productVariant: {
        ...o.productVariant,
        sizeMetersPerBoard: o.productVariant.sizeMetersPerBoard.toString(),
        defaultSalePricePerMeter: o.productVariant.defaultSalePricePerMeter.toString(),
        defaultPurchasePricePerMeter: o.productVariant.defaultPurchasePricePerMeter.toString(),
        priceOverrideTolerancePercent:
          o.productVariant.priceOverrideTolerancePercent?.toString() ?? null,
      },
      collections: o.collections.map((c) => ({
        ...c,
        amount: c.amount.toString(),
      })),
    };
  }
}
