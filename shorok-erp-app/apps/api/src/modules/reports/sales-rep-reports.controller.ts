import { Controller, Get, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SalesRepReportsService, type ReportFilters } from "./sales-rep-reports.service";
import { resolveRange, type DatePreset, type GroupBy } from "./report-range";

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Preset = z.enum([
  "today", "yesterday", "this_week", "this_month", "last_month",
  "q1", "q2", "q3", "q4", "this_year", "last_year", "custom",
]).default("this_month");

const FilterQuery = z.object({
  preset: Preset,
  from: DateStr.optional(),
  to: DateStr.optional(),
  salesRepresentativeId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  productVariantId: z.string().uuid().optional(),
  productCode: z.string().max(60).optional(),
  productNameAr: z.string().max(120).optional(),
  groupBy: z.enum(["day", "month", "quarter", "year"]).default("month"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
type FilterQueryType = z.infer<typeof FilterQuery>;

/** Reporting APIs — server-side filtering/grouping/aggregation only. A sales
 *  representative is a REPORTING DIMENSION on the invoice, never a GL account. */
@Controller("reports/sales-representatives")
export class SalesRepReportsController {
  constructor(private readonly svc: SalesRepReportsService) {}

  private filters(q: FilterQueryType, repIdOverride?: string): ReportFilters {
    const range = resolveRange(q.preset as DatePreset, { from: q.from, to: q.to });
    return {
      from: range.from, to: range.to,
      salesRepresentativeId: repIdOverride ?? q.salesRepresentativeId,
      branchId: q.branchId, customerId: q.customerId,
      productVariantId: q.productVariantId, productCode: q.productCode, productNameAr: q.productNameAr,
    };
  }

  @Get("summary")
  @Roles("OWNER", "ACCOUNTANT")
  summary(@Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType) {
    return this.svc.summary(this.filters(q));
  }

  // §11 net-sales — purpose-specific DTO (net-sales columns only, no COGS/GP).
  @Get("net-sales")
  @Roles("OWNER", "ACCOUNTANT")
  async netSales(@Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType) {
    const s = await this.svc.summary(this.filters(q));
    return {
      from: s.from, to: s.to,
      representatives: s.representatives.map((r) => ({
        salesRepresentativeId: r.salesRepresentativeId, salesRepresentativeName: r.salesRepresentativeName,
        invoiceCount: r.invoiceCount, boards: r.boards, metersSold: r.metersSold,
        metersReturned: r.metersReturned, netMeters: r.netMeters,
        grossSales: r.grossSales, discounts: r.discounts, returns: r.returns, netSales: r.netSales,
      })),
      totals: { invoiceCount: s.totals.invoiceCount, boards: s.totals.boards, metersSold: s.totals.metersSold,
                grossSales: s.totals.grossSales, discounts: s.totals.discounts, netSales: s.totals.netSales },
      salesReturnsSupported: true, // net-sales derives from summary(), which nets confirmed returns
    };
  }

  // §12 gross-profit — purpose-specific DTO (net-sales, COGS, gross profit).
  @Get("gross-profit")
  @Roles("OWNER", "ACCOUNTANT")
  async grossProfit(@Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType) {
    const s = await this.svc.summary(this.filters(q));
    return {
      from: s.from, to: s.to,
      representatives: s.representatives.map((r) => ({
        salesRepresentativeId: r.salesRepresentativeId, salesRepresentativeName: r.salesRepresentativeName,
        invoiceCount: r.invoiceCount, netMeters: r.netMeters, netSales: r.netSales,
        cogs: r.cogs, grossProfit: r.grossProfit,
      })),
      totals: { invoiceCount: s.totals.invoiceCount, netSales: s.totals.netSales, cogs: s.totals.cogs, grossProfit: s.totals.grossProfit },
      salesReturnsSupported: true, // derives from summary(), which nets confirmed returns
      note: "مجمل الربح = صافي المبيعات − تكلفة البضاعة المباعة (ليس صافي الربح).",
    };
  }

  @Get("products")
  @Roles("OWNER", "ACCOUNTANT")
  products(@Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType) {
    return this.svc.products(this.filters(q));
  }

  // §7 drill-down: the exact invoice lines behind a rep×product aggregate.
  @Get("products/drill-down")
  @Roles("OWNER", "ACCOUNTANT")
  productsDrillDown(@Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType) {
    return this.svc.productsDrillDown(this.filters(q));
  }

  @Get(":id/statement")
  @Roles("OWNER", "ACCOUNTANT")
  statement(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType,
  ) {
    return this.svc.statement(this.filters(q, id), q.page, q.pageSize);
  }

  // §6 invoice-line details for a rep's statement invoice.
  @Get(":id/statement/invoices/:invoiceId/lines")
  @Roles("OWNER", "ACCOUNTANT")
  invoiceLines(
    @Param("id") id: string,
    @Param("invoiceId") invoiceId: string,
    @Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType,
  ) {
    return this.svc.invoiceLines(this.filters(q, id), invoiceId);
  }
}

const ProfitabilityQuery = FilterQuery.extend({
  groupDim: z.enum(["representative", "branch", "customer", "product", "day", "month", "quarter", "year"]).default("representative"),
});
type ProfitabilityQueryType = z.infer<typeof ProfitabilityQuery>;

/** Time-series (daily/monthly/quarterly/yearly) + profitability — shared engine. */
@Controller("reports/sales")
export class SalesTimeSeriesController {
  constructor(private readonly svc: SalesRepReportsService) {}

  private toFilters(q: FilterQueryType): ReportFilters {
    const range = resolveRange(q.preset as DatePreset, { from: q.from, to: q.to });
    return {
      from: range.from, to: range.to,
      salesRepresentativeId: q.salesRepresentativeId, branchId: q.branchId, customerId: q.customerId,
      productVariantId: q.productVariantId, productCode: q.productCode, productNameAr: q.productNameAr,
    };
  }

  @Get("time-series")
  @Roles("OWNER", "ACCOUNTANT")
  timeSeries(@Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType) {
    return this.svc.timeSeries(this.toFilters(q), q.groupBy as GroupBy);
  }

  // §8 profitability with a switchable grouping dimension.
  @Get("profitability")
  @Roles("OWNER", "ACCOUNTANT")
  profitability(@Query(new ZodValidationPipe(ProfitabilityQuery)) q: ProfitabilityQueryType) {
    return this.svc.profitability(this.toFilters(q as FilterQueryType), q.groupDim);
  }
}
