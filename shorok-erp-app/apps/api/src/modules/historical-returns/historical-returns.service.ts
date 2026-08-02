import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type {
  HistoricalSalesReturnDetail, HistoricalSalesReturnLineResponse,
  HistoricalSalesReturnListResponse, HistoricalSalesReturnQuery, HistoricalSalesReturnSummary,
} from "@shorok/shared";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { NotFoundError } from "../../common/errors/api-errors";

const D = (v: unknown) => new Decimal((v as { toString(): string } | null)?.toString() ?? "0");

// The list needs only the quantities each row's totals are built from; the
// product resolution is a detail-page concern.
const LIST_INCLUDE = {
  customer: { select: { id: true, code: true, nameAr: true } },
  lines: { select: { boards: true, canonicalMeters: true } },
} satisfies Prisma.HistoricalSalesReturnArchiveInclude;

const DETAIL_INCLUDE = {
  customer: { select: { id: true, code: true, nameAr: true } },
  lines: {
    include: { productVariant: { include: { sku: { select: { code: true, colorNameAr: true } } } } },
    orderBy: { lineNumber: "asc" },
  },
} satisfies Prisma.HistoricalSalesReturnArchiveInclude;

type ListRow = Prisma.HistoricalSalesReturnArchiveGetPayload<{ include: typeof LIST_INCLUDE }>;
type DetailRow = Prisma.HistoricalSalesReturnArchiveGetPayload<{ include: typeof DETAIL_INCLUDE }>;
// The summary is built from the quantities alone, so both row shapes feed it.
type SummaryRow = Omit<ListRow, "lines"> & { lines: Array<{ boards: Prisma.Decimal; canonicalMeters: Prisma.Decimal }> };

/**
 * Historical sales-return archive (أرشيف مردودات المبيعات) — READ ONLY.
 *
 * These six July 2026 paper returns are EVIDENCE, not documents. Their customer
 * effect is already inside the approved 2026-08-01 opening AR balances and
 * their stock effect is already inside the 2026-08-01 physical count, so
 * replaying them would double-count both. The service therefore has no posting,
 * no inventory, no confirm/cancel and no write path at all — that absence is
 * the contract, not an omission. Rows are also REVOKE'd against UPDATE/DELETE
 * in the database.
 *
 * The archive carries no branch dimension (the paper never recorded one), so
 * there is nothing for the branch scope to narrow: access is decided by role on
 * the controller alone.
 */
@Injectable()
export class HistoricalReturnsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: HistoricalSalesReturnQuery): Promise<HistoricalSalesReturnListResponse> {
    const where: Prisma.HistoricalSalesReturnArchiveWhereInput = {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.productVariantId ? { lines: { some: { productVariantId: query.productVariantId } } } : {}),
      ...(query.from || query.to
        ? { documentDate: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } }
        : {}),
      // Free text hits the SOURCE snapshots, so a row is still findable when the
      // paper's customer or product never resolved to a master row.
      ...(query.q
        ? {
            OR: [
              { customerSourceReference: { contains: query.q, mode: "insensitive" as const } },
              { sourceReference: { contains: query.q, mode: "insensitive" as const } },
              { lines: { some: { productSourceCode: { contains: query.q, mode: "insensitive" as const } } } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.historicalSalesReturnArchive.findMany({
      where,
      include: LIST_INCLUDE,
      orderBy: [{ documentDate: "desc" }, { archiveNumber: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;

    // Totals cover the WHOLE filtered archive, not the page — the summary strip
    // must not shrink as the user pages through.
    const [archiveTotals, lineTotals] = await Promise.all([
      this.prisma.historicalSalesReturnArchive.aggregate({ where, _count: true, _sum: { grossValue: true } }),
      this.prisma.historicalSalesReturnArchiveLine.aggregate({ where: { archive: { is: where } }, _sum: { boards: true, canonicalMeters: true } }),
    ]);

    return {
      items: items.map((r) => this.summary(r)),
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      totals: {
        count: archiveTotals._count,
        grossValue: D(archiveTotals._sum.grossValue).toFixed(2),
        boards: D(lineTotals._sum.boards).toFixed(4),
        canonicalMeters: D(lineTotals._sum.canonicalMeters).toFixed(4),
      },
    };
  }

  async get(id: string): Promise<HistoricalSalesReturnDetail> {
    const row = await this.prisma.historicalSalesReturnArchive.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!row) throw new NotFoundError({ id });
    return {
      ...this.summary(row),
      // Provenance — the paper trail that makes the archive auditable.
      sourceSystem: row.sourceSystem,
      sourceFileHash: row.sourceFileHash,
      sourceSheet: row.sourceSheet,
      sourceRow: row.sourceRow,
      importBatchId: row.importBatchId,
      importedBy: row.importedBy,
      createdAt: row.createdAt.toISOString(),
      lines: row.lines.map((l) => this.line(l)),
    };
  }

  private summary(r: SummaryRow): HistoricalSalesReturnSummary {
    const totalBoards = r.lines.reduce((a, l) => a.plus(D(l.boards)), new Decimal(0));
    const totalMeters = r.lines.reduce((a, l) => a.plus(D(l.canonicalMeters)), new Decimal(0));
    return {
      id: r.id,
      archiveNumber: r.archiveNumber.toString(),
      documentDate: r.documentDate.toISOString().slice(0, 10),
      sourceReference: r.sourceReference,
      customerId: r.customerId,
      customer: r.customer ? { id: r.customer.id, code: r.customer.code, nameAr: r.customer.nameAr } : null,
      customerSourceReference: r.customerSourceReference,
      originalInvoiceReference: r.originalInvoiceReference,
      grossValue: D(r.grossValue).toFixed(2),
      totalBoards: totalBoards.toFixed(4),
      totalCanonicalMeters: totalMeters.toFixed(4),
      lineCount: r.lines.length,
      notes: r.notes,
      immutable: r.immutable,
      importedAt: r.importedAt.toISOString(),
    };
  }

  // An unresolved variant is NOT an error: the source snapshot below it always
  // carries what the paper said, so the UI can show the row either way.
  private line(l: DetailRow["lines"][number]): HistoricalSalesReturnLineResponse {
    return {
      id: l.id,
      lineNumber: l.lineNumber,
      productVariantId: l.productVariantId,
      productVariant: l.productVariant
        ? {
            id: l.productVariant.id,
            code: l.productVariant.sku.code,
            colorNameAr: l.productVariant.sku.colorNameAr,
            sizeMetersPerBoard: D(l.productVariant.sizeMetersPerBoard).toFixed(4),
          }
        : null,
      productSourceCode: l.productSourceCode,
      boards: D(l.boards).toFixed(4),
      canonicalMeters: D(l.canonicalMeters).toFixed(4),
      unitPrice: l.unitPrice === null ? null : D(l.unitPrice).toFixed(2),
      lineValue: D(l.lineValue).toFixed(2),
      sourceReference: l.sourceReference,
    };
  }
}
