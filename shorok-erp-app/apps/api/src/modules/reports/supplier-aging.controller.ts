import { Controller, Get, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { SupplierAgingQuerySchema, type SupplierAgingQuery } from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../prisma/prisma.service";

const BUCKETS = [
  { label: "0-30",  days: 30  },
  { label: "31-60", days: 60  },
  { label: "61-90", days: 90  },
  { label: "90+",   days: Infinity },
] as const;

/**
 * GET /reports/supplier-aging?asOf=YYYY-MM-DD
 *
 * For each active supplier, buckets unpaid factory ledger balance by age
 * of the oldest unpaid entry (order_date vs asOf). Balance = total_amount
 * minus paid_amount across all time (running balance per supplier).
 */
@Controller("reports")
export class SupplierAgingController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("supplier-aging")
  @Roles("OWNER", "ACCOUNTANT")
  async aging(
    @Query(new ZodValidationPipe(SupplierAgingQuerySchema)) query: SupplierAgingQuery,
  ) {
    const asOf = query.asOf ? new Date(query.asOf) : new Date();
    asOf.setUTCHours(23, 59, 59, 999);

    const suppliers = await this.prisma.supplier.findMany({
      where: { active: true },
      orderBy: { nameAr: "asc" },
      include: {
        factoryEntries: {
          where: { orderDate: { lte: asOf } },
          orderBy: { orderDate: "asc" },
        },
      },
    });

    const rows = suppliers
      .map((s) => {
        const totalOwed = s.factoryEntries.reduce(
          (a, e) => a.plus(e.totalAmount.toString()).minus(e.paidAmount.toString()),
          new Decimal(0),
        );
        if (totalOwed.lte(0)) return null;

        // Find oldest unpaid entry for bucket classification
        const oldest = s.factoryEntries.find((e) =>
          new Decimal(e.totalAmount.toString()).minus(e.paidAmount.toString()).gt(0),
        );
        const daysOld = oldest
          ? Math.floor((asOf.getTime() - oldest.orderDate.getTime()) / 86_400_000)
          : 0;

        let bucket = "90+";
        if      (daysOld <= 30) bucket = "0-30";
        else if (daysOld <= 60) bucket = "31-60";
        else if (daysOld <= 90) bucket = "61-90";

        return {
          supplierId:  s.id,
          nameAr:      s.nameAr,
          nameEn:      s.nameEn,
          balance:     totalOwed.toFixed(2),
          oldestDays:  daysOld,
          agingBucket: bucket,
          bucketAmounts: {
            "0-30":  daysOld <= 30                      ? totalOwed.toFixed(2) : "0.00",
            "31-60": daysOld > 30 && daysOld <= 60      ? totalOwed.toFixed(2) : "0.00",
            "61-90": daysOld > 60 && daysOld <= 90      ? totalOwed.toFixed(2) : "0.00",
            "90+":   daysOld > 90                       ? totalOwed.toFixed(2) : "0.00",
          },
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const grandTotal = rows.reduce((a, r) => a.plus(r.balance), new Decimal(0));

    return {
      asOf: asOf.toISOString().slice(0, 10),
      grandTotal: grandTotal.toFixed(2),
      rows,
    };
  }
}
