import { Controller, Get, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { AgingQuerySchema, type AgingQuery } from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("reports")
export class AgingController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /reports/aging?type=AR|AP&asOf=YYYY-MM-DD
   * Returns an aging report for Accounts Receivable (customers) or
   * Accounts Payable (suppliers), bucketed into 0-30, 31-60, 61-90, 90+ days.
   */
  @Get("aging")
  @Roles("OWNER", "ACCOUNTANT")
  async aging(
    @Query(new ZodValidationPipe(AgingQuerySchema)) query: AgingQuery,
  ) {
    const asOfStr = query.asOf ?? new Date().toISOString().slice(0, 10);
    const asOf = new Date(asOfStr);
    asOf.setUTCHours(23, 59, 59, 999);

    if (query.type === "AR") {
      return this.computeArAging(asOfStr, asOf);
    } else {
      return this.computeApAging(asOfStr, asOf);
    }
  }

  // ---------------------------------------------------------------------------
  // AR Aging — uses customer_transactions
  // ---------------------------------------------------------------------------
  private async computeArAging(asOfStr: string, asOf: Date) {
    const customers = await this.prisma.customer.findMany({
      where: { active: true },
      select: {
        id: true,
        code: true,
        nameAr: true,
        transactions: {
          where: { date: { lte: asOf } },
          select: { type: true, direction: true, amount: true, date: true },
          orderBy: { date: "asc" },
        },
      },
      orderBy: { code: "asc" },
    });

    type AgingRow = {
      entityId: string;
      code: string;
      nameAr: string;
      totalInvoiced: string;
      totalReceived: string;
      outstanding: string;
      current: string;
      days30: string;
      days60: string;
      days90: string;
      days90plus: string;
    };

    const rows: AgingRow[] = [];

    let sumOutstanding = new Decimal(0);
    let sumCurrent = new Decimal(0);
    let sumDays30 = new Decimal(0);
    let sumDays60 = new Decimal(0);
    let sumDays90 = new Decimal(0);
    let sumDays90plus = new Decimal(0);

    for (const customer of customers) {
      let totalInvoiced = new Decimal(0);
      let totalReceived = new Decimal(0);

      const invoices: { date: Date; amount: Decimal }[] = [];

      for (const tx of customer.transactions) {
        const amount = new Decimal(tx.amount.toString());
        if (tx.direction === "DR") {
          totalInvoiced = totalInvoiced.plus(amount);
          // Collect individual invoice-like DR transactions for aging
          invoices.push({ date: tx.date, amount });
        } else {
          totalReceived = totalReceived.plus(amount);
        }
      }

      const outstanding = totalInvoiced.minus(totalReceived);
      if (outstanding.lessThanOrEqualTo(0)) continue;

      // FIFO aging: distribute outstanding across invoices oldest-first
      const buckets = ageBuckets(outstanding, invoices, asOf);

      rows.push({
        entityId: customer.id,
        code: customer.code,
        nameAr: customer.nameAr,
        totalInvoiced: totalInvoiced.toFixed(2),
        totalReceived: totalReceived.toFixed(2),
        outstanding: outstanding.toFixed(2),
        current: buckets.current.toFixed(2),
        days30: buckets.b30.toFixed(2),
        days60: buckets.b60.toFixed(2),
        days90: buckets.b90.toFixed(2),
        days90plus: buckets.b90plus.toFixed(2),
      });

      sumOutstanding = sumOutstanding.plus(outstanding);
      sumCurrent = sumCurrent.plus(buckets.current);
      sumDays30 = sumDays30.plus(buckets.b30);
      sumDays60 = sumDays60.plus(buckets.b60);
      sumDays90 = sumDays90.plus(buckets.b90);
      sumDays90plus = sumDays90plus.plus(buckets.b90plus);
    }

    return {
      asOf: asOfStr,
      type: "AR",
      rows,
      totals: {
        outstanding: sumOutstanding.toFixed(2),
        current: sumCurrent.toFixed(2),
        days30: sumDays30.toFixed(2),
        days60: sumDays60.toFixed(2),
        days90: sumDays90.toFixed(2),
        days90plus: sumDays90plus.toFixed(2),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // AP Aging — uses purchase_invoices + payments
  // ---------------------------------------------------------------------------
  private async computeApAging(asOfStr: string, asOf: Date) {
    const suppliers = await this.prisma.supplier.findMany({
      where: { active: true },
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        purchaseInvoices: {
          where: {
            status: "CONFIRMED",
            invoiceDate: { lte: asOf },
          },
          select: {
            grandTotal: true,
            invoiceDate: true,
            dueDate: true,
          },
          orderBy: { invoiceDate: "asc" },
        },
      },
      orderBy: { nameAr: "asc" },
    });

    // Fetch all supplier payments up to asOf in one query
    const payments = await this.prisma.payment.findMany({
      where: {
        entityType: "SUPPLIER",
        paymentDate: { lte: asOf },
      },
      select: { entityId: true, amount: true },
    });

    // Index payments by supplierId
    const paymentsBySupplierId = new Map<string, Decimal>();
    for (const p of payments) {
      const existing = paymentsBySupplierId.get(p.entityId) ?? new Decimal(0);
      paymentsBySupplierId.set(p.entityId, existing.plus(p.amount.toString()));
    }

    type AgingRow = {
      entityId: string;
      code: string;
      nameAr: string;
      totalInvoiced: string;
      totalReceived: string;
      outstanding: string;
      current: string;
      days30: string;
      days60: string;
      days90: string;
      days90plus: string;
    };

    const rows: AgingRow[] = [];

    let sumOutstanding = new Decimal(0);
    let sumCurrent = new Decimal(0);
    let sumDays30 = new Decimal(0);
    let sumDays60 = new Decimal(0);
    let sumDays90 = new Decimal(0);
    let sumDays90plus = new Decimal(0);

    for (const supplier of suppliers) {
      let totalInvoiced = new Decimal(0);
      const invoices: { date: Date; amount: Decimal }[] = [];

      for (const inv of supplier.purchaseInvoices) {
        const amount = new Decimal(inv.grandTotal.toString());
        totalInvoiced = totalInvoiced.plus(amount);
        // Use dueDate for aging if available, otherwise invoiceDate
        invoices.push({ date: inv.dueDate ?? inv.invoiceDate, amount });
      }

      const totalPaid = paymentsBySupplierId.get(supplier.id) ?? new Decimal(0);
      const outstanding = totalInvoiced.minus(totalPaid);
      if (outstanding.lessThanOrEqualTo(0)) continue;

      // FIFO aging: distribute outstanding across invoices sorted oldest-first
      const sortedInvoices = [...invoices].sort((a, b) => a.date.getTime() - b.date.getTime());
      const buckets = ageBuckets(outstanding, sortedInvoices, asOf);

      rows.push({
        entityId: supplier.id,
        code: "",  // suppliers don't have a code field
        nameAr: supplier.nameAr,
        totalInvoiced: totalInvoiced.toFixed(2),
        totalReceived: totalPaid.toFixed(2),
        outstanding: outstanding.toFixed(2),
        current: buckets.current.toFixed(2),
        days30: buckets.b30.toFixed(2),
        days60: buckets.b60.toFixed(2),
        days90: buckets.b90.toFixed(2),
        days90plus: buckets.b90plus.toFixed(2),
      });

      sumOutstanding = sumOutstanding.plus(outstanding);
      sumCurrent = sumCurrent.plus(buckets.current);
      sumDays30 = sumDays30.plus(buckets.b30);
      sumDays60 = sumDays60.plus(buckets.b60);
      sumDays90 = sumDays90.plus(buckets.b90);
      sumDays90plus = sumDays90plus.plus(buckets.b90plus);
    }

    return {
      asOf: asOfStr,
      type: "AP",
      rows,
      totals: {
        outstanding: sumOutstanding.toFixed(2),
        current: sumCurrent.toFixed(2),
        days30: sumDays30.toFixed(2),
        days60: sumDays60.toFixed(2),
        days90: sumDays90.toFixed(2),
        days90plus: sumDays90plus.toFixed(2),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Shared FIFO bucket helper
// ---------------------------------------------------------------------------
function ageBuckets(
  outstanding: Decimal,
  invoices: { date: Date; amount: Decimal }[],
  asOf: Date,
): { current: Decimal; b30: Decimal; b60: Decimal; b90: Decimal; b90plus: Decimal } {
  const buckets = {
    current: new Decimal(0),
    b30: new Decimal(0),
    b60: new Decimal(0),
    b90: new Decimal(0),
    b90plus: new Decimal(0),
  };

  let remaining = outstanding;

  for (const inv of invoices) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const diffMs = asOf.getTime() - inv.date.getTime();
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const chunk = Decimal.min(remaining, inv.amount);

    if (days <= 30) {
      buckets.current = buckets.current.plus(chunk);
    } else if (days <= 60) {
      buckets.b30 = buckets.b30.plus(chunk);
    } else if (days <= 90) {
      buckets.b60 = buckets.b60.plus(chunk);
    } else {
      buckets.b90plus = buckets.b90plus.plus(chunk);
    }

    remaining = remaining.minus(chunk);
  }

  // If there's still remaining (e.g., more receipts than individual invoices cover),
  // put it in current as a fallback
  if (remaining.greaterThan(0)) {
    buckets.current = buckets.current.plus(remaining);
  }

  return buckets;
}
