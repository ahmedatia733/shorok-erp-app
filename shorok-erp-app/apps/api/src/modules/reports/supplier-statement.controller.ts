import { Controller, Get, Param, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { SupplierStatementQuerySchema, type SupplierStatementQuery } from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * GET /reports/supplier-statement/:id?from=&to=
 *
 * Full account statement for a supplier using factory_ledger_entries.
 * Rows are ordered by order_date ASC so running balance matches the
 * factory ledger page. Positive balance = still owed to supplier.
 */
@Controller("reports")
export class SupplierStatementController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("supplier-statement/:id")
  @Roles("OWNER", "ACCOUNTANT")
  async statement(
    @Param("id") supplierId: string,
    @Query(new ZodValidationPipe(SupplierStatementQuerySchema)) query: SupplierStatementQuery,
  ) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new NotFoundError({ supplierId });

    const where: Record<string, unknown> = { supplierId };
    if (query.from || query.to) {
      where["orderDate"] = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to   ? { lte: new Date(query.to)   } : {}),
      };
    }

    const entries = await this.prisma.factoryLedgerEntry.findMany({
      where,
      orderBy: [{ orderDate: "asc" }, { createdAt: "asc" }],
      include: {
        productVariant: { include: { sku: { select: { code: true, colorNameAr: true } } } },
      },
    });

    let runningBalance = new Decimal(0);
    const rows = entries.map((e) => {
      const total = new Decimal(e.totalAmount.toString());
      const paid  = new Decimal(e.paidAmount.toString());
      runningBalance = runningBalance.plus(total).minus(paid);

      const isPurchase = total.gt(0);
      const isPayment  = paid.gt(0) && total.isZero();

      return {
        id:          e.id,
        date:        e.orderDate,
        type:        isPayment ? "payment" : isPurchase ? "purchase" : "other",
        description: isPurchase
          ? `شراء — ${e.productVariant?.sku?.colorNameAr ?? ""} (${e.boardsQuantity?.toString() ?? "0"} لوح)`
          : `دفعة`,
        totalAmount:     total.toFixed(2),
        paidAmount:      paid.toFixed(2),
        runningBalance:  runningBalance.toFixed(2),
        journalEntryId:  e.journalEntryId ?? null,
        notes:           e.notes ?? null,
      };
    });

    const totalPurchases = entries.reduce((a, e) => a.plus(e.totalAmount.toString()), new Decimal(0));
    const totalPaid      = entries.reduce((a, e) => a.plus(e.paidAmount.toString()),  new Decimal(0));

    return {
      supplier: { id: supplier.id, nameAr: supplier.nameAr, nameEn: supplier.nameEn },
      totalPurchases: totalPurchases.toFixed(2),
      totalPaid:      totalPaid.toFixed(2),
      closingBalance: runningBalance.toFixed(2),
      rows,
    };
  }
}
