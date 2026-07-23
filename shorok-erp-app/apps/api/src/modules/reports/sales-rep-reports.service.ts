import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { groupKeyExpr, type GroupBy } from "./report-range";

/**
 * Sales-representative + sales reporting, aggregated ENTIRELY in SQL (no
 * per-row JavaScript, no floating point). Source-of-truth rules (see spec §4):
 *
 *  - Only CONFIRMED sales invoices count (DRAFT + CANCELLED excluded).
 *  - Representative = the one persisted on the invoice (sales_representative_id).
 *  - Meters/boards = the PERSISTED line values (meters_quantity, quantity) —
 *    never recomputed from the current variant size.
 *  - Net line sale = line_total (already net of the line discount, ex-VAT);
 *    Σ line_total == invoice.subtotal, so revenue excludes VAT.
 *  - Gross line sale = meters_quantity × unit_price; discount = gross − net.
 *  - COGS = the HISTORICAL cost snapshot taken at posting
 *    (quantity × unit_cost_at_posting) — never the mutable current avg_cost.
 *  - Returns: no canonical sales-return document flow exists yet → 0.
 */

export interface ReportFilters {
  from: string;                 // inclusive YYYY-MM-DD
  to: string;                   // inclusive YYYY-MM-DD
  salesRepresentativeId?: string;
  branchId?: string;
  customerId?: string;
  productVariantId?: string;
  productCode?: string;
  productNameAr?: string;
}

// Shared metric expressions (all summed from sales_invoice_lines l joined to
// their confirmed invoice si and variant/sku).
const M = {
  invoices: `count(distinct si.id)`,
  boards:   `coalesce(sum(l.quantity), 0)`,
  meters:   `coalesce(sum(l.meters_quantity), 0)`,
  gross:    `coalesce(sum(l.meters_quantity * l.unit_price), 0)`,
  net:      `coalesce(sum(l.line_total), 0)`,
  discount: `coalesce(sum(l.meters_quantity * l.unit_price - l.line_total), 0)`,
  cogs:     `coalesce(sum(l.quantity * coalesce(l.unit_cost_at_posting, 0)), 0)`,
};

@Injectable()
export class SalesRepReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Confirmed-invoice + filter predicate applied to alias `si` (invoice) and
   *  `sku`/`v` (product). Returns 0 rows for drafts/cancelled by construction. */
  private where(f: ReportFilters): Prisma.Sql {
    const parts: Prisma.Sql[] = [
      Prisma.sql`si.status = 'CONFIRMED'`,
      Prisma.sql`si.invoice_date BETWEEN ${f.from}::date AND ${f.to}::date`,
    ];
    if (f.salesRepresentativeId) parts.push(Prisma.sql`si.sales_representative_id = ${f.salesRepresentativeId}::uuid`);
    if (f.branchId)    parts.push(Prisma.sql`si.branch_id = ${f.branchId}::uuid`);
    if (f.customerId)  parts.push(Prisma.sql`si.customer_id = ${f.customerId}::uuid`);
    if (f.productVariantId) parts.push(Prisma.sql`l.product_variant_id = ${f.productVariantId}::uuid`);
    if (f.productCode) parts.push(Prisma.sql`sku.code = ${f.productCode}`);
    if (f.productNameAr) parts.push(Prisma.sql`sku.color_name_ar ILIKE ${"%" + f.productNameAr + "%"}`);
    return Prisma.join(parts, " AND ");
  }

  private num = (v: unknown, dp = 2) => new Decimal((v as { toString(): string })?.toString() ?? "0").toFixed(dp);

  private repRow = (r: any) => ({
    salesRepresentativeId: r.rep_id,
    salesRepresentativeName: r.rep_name ?? "— بدون مندوب —",
    invoiceCount: Number(r.invoices),
    boards: this.num(r.boards, 4),
    metersSold: this.num(r.meters, 4),
    metersReturned: "0.0000",
    netMeters: this.num(r.meters, 4),
    grossSales: this.num(r.gross),
    discounts: this.num(r.discount),
    returns: "0.00",
    netSales: this.num(r.net),
    cogs: this.num(r.cogs),
    grossProfit: new Decimal(this.num(r.net)).minus(this.num(r.cogs)).toFixed(2),
  });

  /** §7 — one row per representative (absolute values only, no percentages). */
  async summary(f: ReportFilters) {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT si.sales_representative_id AS rep_id, rep.name_ar AS rep_name,
             ${Prisma.raw(M.invoices)} AS invoices, ${Prisma.raw(M.boards)} AS boards,
             ${Prisma.raw(M.meters)} AS meters, ${Prisma.raw(M.gross)} AS gross,
             ${Prisma.raw(M.net)} AS net, ${Prisma.raw(M.discount)} AS discount,
             ${Prisma.raw(M.cogs)} AS cogs
      FROM sales_invoices si
      JOIN sales_invoice_lines l ON l.invoice_id = si.id
      JOIN product_variants v ON v.id = l.product_variant_id
      JOIN product_skus sku ON sku.id = v.sku_id
      LEFT JOIN sales_representatives rep ON rep.id = si.sales_representative_id
      WHERE ${this.where(f)}
      GROUP BY si.sales_representative_id, rep.name_ar
      ORDER BY net DESC
    `);
    const reps = rows.map((r) => this.repRow(r));
    return { from: f.from, to: f.to, representatives: reps, totals: this.totalize(reps) };
  }

  /** §8 — a representative's summary cards + their confirmed invoices (paged). */
  async statement(f: ReportFilters, page = 1, pageSize = 50) {
    const cards = (await this.summary(f)).representatives[0] ?? this.repRow({});
    const offset = (Math.max(1, page) - 1) * pageSize;
    const invoices = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT si.id, si.invoice_number::text AS invoice_number, si.invoice_date::text AS invoice_date,
             si.status, c.code AS customer_code, c.name_ar AS customer_name, b.name_ar AS branch_name,
             coalesce(sum(l.quantity),0) AS boards, coalesce(sum(l.meters_quantity),0) AS meters,
             coalesce(sum(l.meters_quantity*l.unit_price - l.line_total),0) AS discount,
             coalesce(sum(l.line_total),0) AS net,
             coalesce(sum(l.quantity*coalesce(l.unit_cost_at_posting,0)),0) AS cogs
      FROM sales_invoices si
      JOIN sales_invoice_lines l ON l.invoice_id = si.id
      JOIN product_variants v ON v.id = l.product_variant_id
      JOIN product_skus sku ON sku.id = v.sku_id
      JOIN customers c ON c.id = si.customer_id
      JOIN branches b ON b.id = si.branch_id
      WHERE ${this.where(f)}
      GROUP BY si.id, si.invoice_number, si.invoice_date, si.status, c.code, c.name_ar, b.name_ar
      ORDER BY si.invoice_date DESC, si.invoice_number DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `);
    const totalRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT count(distinct si.id)::int AS n
      FROM sales_invoices si JOIN sales_invoice_lines l ON l.invoice_id = si.id
      JOIN product_variants v ON v.id=l.product_variant_id JOIN product_skus sku ON sku.id=v.sku_id
      WHERE ${this.where(f)}`);
    return {
      summary: cards,
      invoices: invoices.map((r) => ({
        id: r.id, invoiceNumber: r.invoice_number, invoiceDate: r.invoice_date, status: r.status,
        customerCode: r.customer_code, customerName: r.customer_name, branchName: r.branch_name,
        boards: this.num(r.boards, 4), meters: this.num(r.meters, 4), discount: this.num(r.discount),
        returns: "0.00", netInvoice: this.num(r.net), cogs: this.num(r.cogs),
        grossProfit: new Decimal(this.num(r.net)).minus(this.num(r.cogs)).toFixed(2),
      })),
      page, pageSize, totalInvoices: Number(totalRows[0]?.n ?? 0),
    };
  }

  /** §10 — representative × product (board type) aggregation. */
  async products(f: ReportFilters) {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT si.sales_representative_id AS rep_id, rep.name_ar AS rep_name,
             sku.code AS product_code, sku.color_name_ar AS product_name,
             string_agg(distinct v.size_meters_per_board::text, ', ' ORDER BY v.size_meters_per_board::text) AS sizes,
             ${Prisma.raw(M.invoices)} AS invoices, ${Prisma.raw(M.boards)} AS boards,
             ${Prisma.raw(M.meters)} AS meters, ${Prisma.raw(M.net)} AS net, ${Prisma.raw(M.cogs)} AS cogs
      FROM sales_invoices si
      JOIN sales_invoice_lines l ON l.invoice_id = si.id
      JOIN product_variants v ON v.id = l.product_variant_id
      JOIN product_skus sku ON sku.id = v.sku_id
      LEFT JOIN sales_representatives rep ON rep.id = si.sales_representative_id
      WHERE ${this.where(f)}
      GROUP BY si.sales_representative_id, rep.name_ar, sku.code, sku.color_name_ar
      ORDER BY rep.name_ar NULLS FIRST, net DESC
    `);
    return {
      from: f.from, to: f.to,
      rows: rows.map((r) => ({
        salesRepresentativeId: r.rep_id, salesRepresentativeName: r.rep_name ?? "— بدون مندوب —",
        productCode: r.product_code, productName: r.product_name, sizes: r.sizes,
        invoiceCount: Number(r.invoices), boards: this.num(r.boards, 4), metersSold: this.num(r.meters, 4),
        metersReturned: "0.0000", netMeters: this.num(r.meters, 4), netSales: this.num(r.net),
        cogs: this.num(r.cogs), grossProfit: new Decimal(this.num(r.net)).minus(this.num(r.cogs)).toFixed(2),
      })),
    };
  }

  /** §13 — one shared time-series engine; groupBy switches day/month/quarter/year. */
  async timeSeries(f: ReportFilters, groupBy: GroupBy) {
    const key = Prisma.raw(groupKeyExpr(groupBy, "si.invoice_date"));
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT ${key} AS period,
             ${Prisma.raw(M.invoices)} AS invoices, ${Prisma.raw(M.boards)} AS boards,
             ${Prisma.raw(M.meters)} AS meters, ${Prisma.raw(M.net)} AS net,
             ${Prisma.raw(M.discount)} AS discount, ${Prisma.raw(M.cogs)} AS cogs
      FROM sales_invoices si
      JOIN sales_invoice_lines l ON l.invoice_id = si.id
      JOIN product_variants v ON v.id = l.product_variant_id
      JOIN product_skus sku ON sku.id = v.sku_id
      WHERE ${this.where(f)}
      GROUP BY period
      ORDER BY period ASC
    `);
    const series = rows.map((r) => ({
      period: r.period, invoiceCount: Number(r.invoices), boards: this.num(r.boards, 4),
      metersSold: this.num(r.meters, 4), netMeters: this.num(r.meters, 4), netSales: this.num(r.net),
      discounts: this.num(r.discount), cogs: this.num(r.cogs),
      grossProfit: new Decimal(this.num(r.net)).minus(this.num(r.cogs)).toFixed(2),
    }));
    return { from: f.from, to: f.to, groupBy, series, totals: this.totalizeSeries(series) };
  }

  private totalize(reps: ReturnType<SalesRepReportsService["repRow"]>[]) {
    const add = (k: keyof (typeof reps)[number]) => reps.reduce((a, r) => a.plus(r[k] as string), new Decimal(0));
    return {
      invoiceCount: reps.reduce((a, r) => a + r.invoiceCount, 0),
      boards: add("boards").toFixed(4), metersSold: add("metersSold").toFixed(4), netMeters: add("netMeters").toFixed(4),
      grossSales: add("grossSales").toFixed(2), discounts: add("discounts").toFixed(2),
      netSales: add("netSales").toFixed(2), cogs: add("cogs").toFixed(2), grossProfit: add("grossProfit").toFixed(2),
    };
  }
  private totalizeSeries(series: any[]) {
    const add = (k: string) => series.reduce((a, r) => a.plus(r[k]), new Decimal(0));
    return {
      invoiceCount: series.reduce((a, r) => a + r.invoiceCount, 0),
      boards: add("boards").toFixed(4), metersSold: add("metersSold").toFixed(4),
      netSales: add("netSales").toFixed(2), cogs: add("cogs").toFixed(2), grossProfit: add("grossProfit").toFixed(2),
    };
  }
}
