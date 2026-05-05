import { Controller, Get, Query } from "@nestjs/common";
import {
  FactoryLedgerQuerySchema,
  type FactoryLedgerQuery,
} from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../prisma/prisma.service";
import { serializeEntry } from "./serializer";

/**
 * T102 — GET /factory-ledger?supplierId=&cursor=&limit=
 *
 * Newest first within a supplier; running_balance comes straight from the
 * persisted column (kept correct by the recompute pass on every write).
 */
@Controller("factory-ledger")
export class FactoryLedgerListController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles("OWNER", "ACCOUNTANT")
  async list(
    @Query(new ZodValidationPipe(FactoryLedgerQuerySchema)) query: FactoryLedgerQuery,
  ) {
    const rows = await this.prisma.factoryLedgerEntry.findMany({
      where: { supplierId: query.supplierId },
      orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        productVariant: { include: { sku: true } },
        creator: { select: { id: true, name: true } },
      },
    });

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.id ?? null : null;

    return {
      data: data.map((row) => ({
        ...serializeEntry(row),
        productVariant: row.productVariant
          ? {
              id: row.productVariant.id,
              sizeMetersPerBoard: row.productVariant.sizeMetersPerBoard.toString(),
              sku: {
                code: row.productVariant.sku.code,
                colorNameAr: row.productVariant.sku.colorNameAr,
                colorNameEn: row.productVariant.sku.colorNameEn,
              },
            }
          : null,
        creator: row.creator,
      })),
      nextCursor,
    };
  }
}
