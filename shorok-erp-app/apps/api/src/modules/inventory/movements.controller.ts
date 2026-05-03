import { Controller, Get, Query } from "@nestjs/common";
import {
  InventoryMovementsQuerySchema,
  type InventoryMovementsQuery,
} from "@shorok/shared";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("inventory/movements")
export class MovementsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(InventoryMovementsQuerySchema))
    query: InventoryMovementsQuery,
  ) {
    const where = {
      branchId: query.branchId,
      ...(query.productVariantId ? { productVariantId: query.productVariantId } : {}),
      ...(query.movementType ? { movementType: query.movementType } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.inventoryMovement.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
      data: data.map((m) => ({
        id: m.id,
        branchId: m.branchId,
        productVariantId: m.productVariantId,
        movementType: m.movementType,
        boardsQuantity: m.boardsQuantity.toString(),
        metersQuantity: m.metersQuantity.toString(),
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        createdAt: m.createdAt,
        humanReadableNote: m.humanReadableNote,
        creator: m.creator,
        productVariant: {
          id: m.productVariant.id,
          sizeMetersPerBoard: m.productVariant.sizeMetersPerBoard.toString(),
          sku: m.productVariant.sku,
        },
      })),
      nextCursor,
    };
  }
}
