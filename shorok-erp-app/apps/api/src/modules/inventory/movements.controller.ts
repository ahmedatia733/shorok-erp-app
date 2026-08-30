import { Controller, Get, Query } from "@nestjs/common";
import {
  BOARD_SIZE_BIG,
  BOARD_SIZE_SMALL,
  InventoryMovementsQuerySchema,
  classifyBoardSize,
  parseMovementSearch,
  unitsToDecimalString,
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
    // The search box carries two different questions at once: a size, which is
    // a property of the variant, and ordinary words, which are not. Splitting
    // them here — rather than matching «ك» as a substring of the Arabic text —
    // is what stops a product called «كوبرا» from answering a search for كبير.
    const search = parseMovementSearch(query.search);

    const sizeFilter =
      search.sizeKind === "BIG"
        ? { sizeMetersPerBoard: BOARD_SIZE_BIG }
        : search.sizeKind === "SMALL"
          ? { sizeMetersPerBoard: BOARD_SIZE_SMALL }
          : search.sizeKind === "CUSTOM"
            ? { sizeMetersPerBoard: { notIn: [BOARD_SIZE_BIG, BOARD_SIZE_SMALL] } }
            : search.exactSizeUnits !== null
              ? { sizeMetersPerBoard: unitsToDecimalString(search.exactSizeUnits) }
              : null;

    // Every word must appear somewhere, so adding a word narrows the result
    // rather than widening it.
    const termFilters = search.terms.map((term) => ({
      OR: [
        { productVariant: { sku: { code: { contains: term, mode: "insensitive" as const } } } },
        { productVariant: { sku: { colorNameAr: { contains: term, mode: "insensitive" as const } } } },
        { productVariant: { sku: { colorNameEn: { contains: term, mode: "insensitive" as const } } } },
        { humanReadableNote: { contains: term, mode: "insensitive" as const } },
        { referenceType: { contains: term, mode: "insensitive" as const } },
      ],
    }));

    const where: Record<string, unknown> = {
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.productVariantId ? { productVariantId: query.productVariantId } : {}),
      ...(query.movementType ? { movementType: query.movementType } : {}),
      ...(query.referenceId ? { referenceId: query.referenceId } : {}),
      ...(query.referenceType ? { referenceType: query.referenceType } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(sizeFilter ? { productVariant: sizeFilter } : {}),
      ...(termFilters.length ? { AND: termFilters } : {}),
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
        // Derived on the way out from the variant the movement actually points
        // at, never stored — so a movement written long before this existed
        // describes its own size correctly.
        boardSize: classifyBoardSize(m.productVariant.sizeMetersPerBoard.toString()),
      })),
      nextCursor,
    };
  }
}
