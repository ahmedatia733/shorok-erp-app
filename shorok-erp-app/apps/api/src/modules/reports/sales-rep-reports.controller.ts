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

  // §11 net-sales and §12 gross-profit are projections of the same per-rep row
  // set (absolute values only) — exposed as dedicated endpoints for the UI.
  @Get("net-sales")
  @Roles("OWNER", "ACCOUNTANT")
  netSales(@Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType) {
    return this.svc.summary(this.filters(q));
  }

  @Get("gross-profit")
  @Roles("OWNER", "ACCOUNTANT")
  grossProfit(@Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType) {
    return this.svc.summary(this.filters(q));
  }

  @Get("products")
  @Roles("OWNER", "ACCOUNTANT")
  products(@Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType) {
    return this.svc.products(this.filters(q));
  }

  @Get(":id/statement")
  @Roles("OWNER", "ACCOUNTANT")
  statement(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType,
  ) {
    return this.svc.statement(this.filters(q, id), q.page, q.pageSize);
  }
}

/** Time-series (daily/monthly/quarterly/yearly) — one shared engine. */
@Controller("reports/sales")
export class SalesTimeSeriesController {
  constructor(private readonly svc: SalesRepReportsService) {}

  @Get("time-series")
  @Roles("OWNER", "ACCOUNTANT")
  timeSeries(@Query(new ZodValidationPipe(FilterQuery)) q: FilterQueryType) {
    const range = resolveRange(q.preset as DatePreset, { from: q.from, to: q.to });
    const filters: ReportFilters = {
      from: range.from, to: range.to,
      salesRepresentativeId: q.salesRepresentativeId, branchId: q.branchId, customerId: q.customerId,
      productVariantId: q.productVariantId, productCode: q.productCode, productNameAr: q.productNameAr,
    };
    return this.svc.timeSeries(filters, q.groupBy as GroupBy);
  }
}
