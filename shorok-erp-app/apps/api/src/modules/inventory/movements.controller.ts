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

/**
 * The movement reference types that stand for a sale. All four store the
 * SalesInvoice id directly in `referenceId` — a revision and its reversal point
 * at the invoice itself, not at a revision row — which is what lets one lookup
 * serve every one of them. Verified against production before relying on it.
 */
const SALES_INVOICE_REFS = [
  "sales_invoice",
  "sales_invoice_cancel",
  "sales_invoice_revision",
  "sales_invoice_revision_reversal",
] as const;

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

    // A customer name is now a visible identifier for a sale, so it has to be
    // searchable. The movement has no relation to the invoice — `referenceId` is
    // a plain column — so the invoices belonging to matching customers are
    // resolved first and matched by id. Two small lookups per term, not one per
    // row, and it stays a WHERE clause so paging and counts are unaffected.
    const invoiceIdsByTerm = new Map<string, string[]>();
    for (const term of search.terms) {
      const invoices = await this.prisma.salesInvoice.findMany({
        where: { customer: { OR: [{ nameAr: { contains: term, mode: "insensitive" } }, { code: { contains: term, mode: "insensitive" } }] } },
        select: { id: true },
      });
      invoiceIdsByTerm.set(term, invoices.map((i) => i.id));
    }

    // Every word must appear somewhere, so adding a word narrows the result
    // rather than widening it.
    const termFilters = search.terms.map((term) => {
      const invoiceIds = invoiceIdsByTerm.get(term) ?? [];
      return {
        OR: [
          { productVariant: { sku: { code: { contains: term, mode: "insensitive" as const } } } },
          { productVariant: { sku: { colorNameAr: { contains: term, mode: "insensitive" as const } } } },
          { productVariant: { sku: { colorNameEn: { contains: term, mode: "insensitive" as const } } } },
          { humanReadableNote: { contains: term, mode: "insensitive" as const } },
          { referenceType: { contains: term, mode: "insensitive" as const } },
          // Scoped to the sales family so a stray id collision cannot match.
          ...(invoiceIds.length
            ? [{
                AND: [
                  { referenceType: { in: [...SALES_INVOICE_REFS] } },
                  { referenceId: { in: invoiceIds } },
                ],
              }]
            : []),
        ],
      };
    });

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

    // Who a sale was to is the thing worth reading in this list; «فاتورة مبيعات»
    // is the same on every row. The movement stores only a reference id, so the
    // invoices for this page are fetched once, together — one query however many
    // rows there are, never one per row.
    const invoiceIds = [
      ...new Set(
        data
          .filter((m) => m.referenceType && (SALES_INVOICE_REFS as readonly string[]).includes(m.referenceType))
          .map((m) => m.referenceId)
          .filter((id): id is string => !!id),
      ),
    ];
    const invoices = invoiceIds.length
      ? await this.prisma.salesInvoice.findMany({
          where: { id: { in: invoiceIds } },
          select: {
            id: true,
            invoiceNumber: true,
            customer: { select: { id: true, code: true, nameAr: true } },
          },
        })
      : [];
    const byInvoice = new Map(invoices.map((i) => [i.id, i]));

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
        // Present only for a sale, and only when its invoice still resolves.
        // Null is a normal answer — the caller falls back to the generic label
        // rather than inventing a customer.
        salesDocument: (() => {
          if (!m.referenceType || !(SALES_INVOICE_REFS as readonly string[]).includes(m.referenceType)) return null;
          const inv = m.referenceId ? byInvoice.get(m.referenceId) : undefined;
          if (!inv) return null;
          return {
            invoiceNumber: inv.invoiceNumber.toString(),
            customerId: inv.customer.id,
            customerCode: inv.customer.code,
            customerName: inv.customer.nameAr,
          };
        })(),
      })),
      nextCursor,
    };
  }
}
