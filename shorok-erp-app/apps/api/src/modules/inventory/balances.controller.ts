import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { UuidSchema } from "@shorok/shared";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../prisma/prisma.service";

const BalancesQuerySchema = z.object({
  branchId: UuidSchema,
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
type BalancesQuery = z.infer<typeof BalancesQuerySchema>;

@Controller("inventory/balances")
export class BalancesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query(new ZodValidationPipe(BalancesQuerySchema)) query: BalancesQuery) {
    const settings = await this.prisma.systemSettings.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
      select: { lowStockThresholdBoards: true },
    });
    const lowStockThreshold = settings.lowStockThresholdBoards;

    // Cursor is the productVariantId of the last seen row, since the PK is
    // (branchId, productVariantId).
    const rows = await this.prisma.branchInventoryBalance.findMany({
      where: { branchId: query.branchId },
      orderBy: { productVariantId: "asc" },
      take: query.limit + 1,
      ...(query.cursor
        ? {
            cursor: {
              branchId_productVariantId: {
                branchId: query.branchId,
                productVariantId: query.cursor,
              },
            },
            skip: 1,
          }
        : {}),
      include: {
        productVariant: {
          select: {
            id: true,
            sizeMetersPerBoard: true,
            sku: {
              select: { id: true, code: true, colorNameAr: true, colorNameEn: true },
            },
          },
        },
      },
    });

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.productVariantId ?? null : null;

    return {
      data: data.map((row) => ({
        branchId: row.branchId,
        productVariantId: row.productVariantId,
        boardsOnHand: row.boardsOnHand.toString(),
        metersOnHand: row.metersOnHand.toString(),
        lastCountedAt: row.lastCountedAt,
        sizeMetersPerBoard: row.productVariant.sizeMetersPerBoard.toString(),
        sku: row.productVariant.sku,
        lowStock: row.boardsOnHand.lessThanOrEqualTo(lowStockThreshold),
      })),
      nextCursor,
    };
  }
}
