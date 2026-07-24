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
 *  - COGS = the HISTORICAL cost snapshot taken at posting: the meter-based
 *    line_cogs_at_posting when present, else the legacy per-board fallback
 *    (quantity × unit_cost_at_posting). Never the mutable current avg cost.
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
  // Historical COGS: the NEW meter-based lineCogsAtPosting when present, else the
  // LEGACY per-board snapshot (boards × unit_cost_at_posting). Never recomputed
  // from the current mutable avg cost.
  cogs:     `coalesce(sum(coalesce(l.line_cogs_at_posting, l.quantity * coalesce(l.unit_cost_at_posting, 0))), 0)`,
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

  /** CONFIRMED sales-return predicate (returnDate-based; rep/branch/customer/
   *  product filters mirror `where`). Draft/cancelled returns are excluded. */
  private returnsWhere(f: ReportFilters): Prisma.Sql {
    const parts: Prisma.Sql[] = [
      Prisma.sql`sr.status = 'CONFIRMED'`,
      Prisma.sql`sr.return_date BETWEEN ${f.from}::date AND ${f.to}::date`,
    ];
    if (f.salesRepresentativeId) parts.push(Prisma.sql`sr.sales_representative_id = ${f.salesRepresentativeId}::uuid`);
    if (f.branchId)    parts.push(Prisma.sql`sr.branch_id = ${f.branchId}::uuid`);
    if (f.customerId)  parts.push(Prisma.sql`sr.customer_id = ${f.customerId}::uuid`);
    if (f.productVariantId) parts.push(Prisma.sql`rl.product_variant_id = ${f.productVariantId}::uuid`);
    if (f.productCode) parts.push(Prisma.sql`sku.code = ${f.productCode}`);
    if (f.productNameAr) parts.push(Prisma.sql`sku.color_name_ar ILIKE ${"%" + f.productNameAr + "%"}`);
    return Prisma.join(parts, " AND ");
  }

  /** Σ confirmed sales returns grouped by an arbitrary key expression (on the
   *  sr/rl/sku/c/b/rep aliases). Values: net ex-tax, reversed COGS, metres. */
  private async returnsByKey(f: ReportFilters, keyExpr: Prisma.Sql) {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT ${keyExpr} AS grp_key,
             coalesce(sum(rl.return_net_ex_tax), 0) AS ret_net,
             coalesce(sum(rl.return_cogs), 0) AS ret_cogs,
             coalesce(sum(rl.returned_meters_quantity), 0) AS ret_meters
      FROM sales_returns sr
      JOIN sales_return_lines rl ON rl.sales_return_id = sr.id
      JOIN product_variants v ON v.id = rl.product_variant_id
      JOIN product_skus sku ON sku.id = v.sku_id
      JOIN customers c ON c.id = sr.customer_id
      JOIN branches b ON b.id = sr.branch_id
      LEFT JOIN sales_representatives rep ON rep.id = sr.sales_representative_id
      WHERE ${this.returnsWhere(f)}
      GROUP BY grp_key
    `);
    return new Map(rows.map((r) => [String(r.grp_key ?? ""), {
      net: new Decimal(r.ret_net.toString()), cogs: new Decimal(r.ret_cogs.toString()), meters: new Decimal(r.ret_meters.toString()),
    }]));
  }

  /** Subtract a rep/group's confirmed returns from its gross figures. */
  private applyReturns<T extends { metersReturned: string; netMeters: string; returns: string; netSales: string; cogs: string; grossProfit: string }>(
    base: T, ret?: { net: Decimal; cogs: Decimal; meters: Decimal },
  ): T {
    if (!ret) return base;
    const netSales = new Decimal(base.netSales).minus(ret.net);
    const cogs = new Decimal(base.cogs).minus(ret.cogs);
    const netMeters = new Decimal(base.netMeters).minus(ret.meters);
    return {
      ...base,
      metersReturned: ret.meters.toFixed(4),
      netMeters: netMeters.toFixed(4),
      returns: ret.net.toFixed(2),
      netSales: netSales.toFixed(2),
      cogs: cogs.toFixed(2),
      grossProfit: netSales.minus(cogs).toFixed(2),
    };
  }

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
    // Net confirmed sales returns (attributed to the ORIGINAL invoice's rep).
    const retMap = await this.returnsByKey(f, Prisma.raw("sr.sales_representative_id::text"));
    const reps = rows.map((r) => this.applyReturns(this.repRow(r), retMap.get(String(r.rep_id ?? ""))));
    return { from: f.from, to: f.to, salesReturnsSupported: true, representatives: reps, totals: this.totalize(reps) };
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
             coalesce(sum(coalesce(l.line_cogs_at_posting, l.quantity*coalesce(l.unit_cost_at_posting,0))),0) AS cogs
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
    // Confirmed returns per ORIGINAL invoice (returnDate-scoped) so each invoice
    // row shows its returns / net-of-returns COGS + gross profit.
    const retByInvoice = await this.returnsByKey(f, Prisma.raw("sr.original_sales_invoice_id::text"));
    return {
      summary: cards,
      salesReturnsSupported: true,
      invoices: invoices.map((r) => {
        const ret = retByInvoice.get(String(r.id)) ?? { net: new Decimal(0), cogs: new Decimal(0), meters: new Decimal(0) };
        const netInvoice = new Decimal(this.num(r.net)).minus(ret.net);
        const cogs = new Decimal(this.num(r.cogs)).minus(ret.cogs);
        return {
          id: r.id, invoiceNumber: r.invoice_number, invoiceDate: r.invoice_date, status: r.status,
          customerCode: r.customer_code, customerName: r.customer_name, branchName: r.branch_name,
          boards: this.num(r.boards, 4), meters: this.num(r.meters, 4), discount: this.num(r.discount),
          returns: ret.net.toFixed(2), metersReturned: ret.meters.toFixed(4),
          netInvoice: netInvoice.toFixed(2), cogs: cogs.toFixed(2),
          grossProfit: netInvoice.minus(cogs).toFixed(2),
        };
      }),
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
    // Returns keyed by rep|product so each rep×product row nets its own returns.
    const retMap = await this.returnsByKey(f, Prisma.raw("coalesce(sr.sales_representative_id::text,'') || '|' || sku.code"));
    return {
      from: f.from, to: f.to, salesReturnsSupported: true,
      rows: rows.map((r) => {
        const base = {
          salesRepresentativeId: r.rep_id, salesRepresentativeName: r.rep_name ?? "— بدون مندوب —",
          productCode: r.product_code, productName: r.product_name, sizes: r.sizes,
          invoiceCount: Number(r.invoices), boards: this.num(r.boards, 4), metersSold: this.num(r.meters, 4),
          metersReturned: "0.0000", netMeters: this.num(r.meters, 4), returns: "0.00", netSales: this.num(r.net),
          cogs: this.num(r.cogs), grossProfit: new Decimal(this.num(r.net)).minus(this.num(r.cogs)).toFixed(2),
        };
        return this.applyReturns(base, retMap.get(`${r.rep_id ?? ""}|${r.product_code}`));
      }),
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
    // Returns grouped by the SAME period bucket, on the return date.
    const retMap = await this.returnsByKey(f, Prisma.raw(groupKeyExpr(groupBy, "sr.return_date")));
    const series = rows.map((r) => {
      const base = {
        period: r.period, invoiceCount: Number(r.invoices), boards: this.num(r.boards, 4),
        metersSold: this.num(r.meters, 4), metersReturned: "0.0000", netMeters: this.num(r.meters, 4),
        returns: "0.00", netSales: this.num(r.net),
        discounts: this.num(r.discount), cogs: this.num(r.cogs),
        grossProfit: new Decimal(this.num(r.net)).minus(this.num(r.cogs)).toFixed(2),
      };
      return this.applyReturns(base, retMap.get(String(r.period ?? "")));
    });
    return { from: f.from, to: f.to, groupBy, salesReturnsSupported: true, series, totals: this.totalizeSeries(series) };
  }

  /** §6 — per-line details for ONE invoice (historical values; never recomputed
   *  from current variant). Rep filter keeps it scoped to the statement. */
  async invoiceLines(f: ReportFilters, invoiceId: string) {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT sku.code AS product_code, sku.color_name_ar AS product_name,
             v.size_meters_per_board::text AS variant_size,
             l.length_m::text AS length_m, l.width_m::text AS width_m,
             l.quantity AS boards, l.meters_quantity AS meters,
             l.unit_price AS unit_price, l.discount_pct AS discount_pct,
             (l.meters_quantity * l.unit_price - l.line_total) AS discount,
             l.line_total AS net, coalesce(l.unit_cost_at_posting, 0) AS cost_per_board,
             coalesce(l.line_cogs_at_posting, l.quantity * coalesce(l.unit_cost_at_posting, 0)) AS line_cogs, l.unit_cost_per_meter_at_posting::text AS cost_per_meter
      FROM sales_invoices si
      JOIN sales_invoice_lines l ON l.invoice_id = si.id
      JOIN product_variants v ON v.id = l.product_variant_id
      JOIN product_skus sku ON sku.id = v.sku_id
      WHERE si.id = ${invoiceId}::uuid AND ${this.where(f)}
      ORDER BY l.id
    `);
    // Confirmed returns booked against this original invoice (all-time), so the
    // drill-down distinguishes the invoice's returns / net-of-returns figures.
    const retRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT coalesce(sum(rl.return_net_ex_tax),0) AS ret_net,
             coalesce(sum(rl.return_cogs),0) AS ret_cogs,
             coalesce(sum(rl.returned_meters_quantity),0) AS ret_meters
      FROM sales_returns sr JOIN sales_return_lines rl ON rl.sales_return_id = sr.id
      WHERE sr.status='CONFIRMED' AND sr.original_sales_invoice_id = ${invoiceId}::uuid`);
    const ret = retRows[0] ?? {};
    return {
      invoiceId,
      invoiceWebRoute: `/sales/invoices?open=${invoiceId}`, // canonical sales-invoice route
      salesReturnsSupported: true,
      returnsTotal: this.num(ret.ret_net), returnsCogs: this.num(ret.ret_cogs), metersReturned: this.num(ret.ret_meters, 4),
      lines: rows.map((r) => {
        const sizeMode = r.width_m != null ? "CUSTOM"
          : r.length_m != null ? (new Decimal(r.length_m).eq("5.25") ? "LARGE" : new Decimal(r.length_m).eq("4") ? "SMALL" : "CUSTOM")
          : "DEFAULT";
        const net = this.num(r.net), cogs = this.num(r.line_cogs);
        return {
          productCode: r.product_code, productName: r.product_name,
          variantSize: this.num(r.variant_size, 4), sizeMode,
          lengthM: r.length_m ? this.num(r.length_m, 4) : null,
          widthM: r.width_m ? this.num(r.width_m, 4) : null,
          boards: this.num(r.boards, 4), metersQuantity: this.num(r.meters, 4),
          salePricePerMeter: this.num(r.unit_price), lineDiscount: this.num(r.discount),
          lineNet: net,
          costPerMeterAtPosting: r.cost_per_meter != null ? this.num(r.cost_per_meter, 4) : null, // تكلفة المتر وقت البيع
          costPerBoard: this.num(r.cost_per_board),  // legacy per-board snapshot
          lineCogs: cogs, lineGrossProfit: new Decimal(net).minus(cogs).toFixed(2),
        };
      }),
    };
  }

  /** §7 — the exact invoices + lines behind a rep×product aggregate row. */
  async productsDrillDown(f: ReportFilters) {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT si.id AS invoice_id, si.invoice_number::text AS invoice_number, si.invoice_date::text AS invoice_date,
             c.name_ar AS customer_name, b.name_ar AS branch_name, sku.code AS product_code,
             l.quantity AS boards, l.meters_quantity AS meters, l.line_total AS net,
             coalesce(l.line_cogs_at_posting, l.quantity * coalesce(l.unit_cost_at_posting,0)) AS cogs
      FROM sales_invoices si
      JOIN sales_invoice_lines l ON l.invoice_id = si.id
      JOIN product_variants v ON v.id = l.product_variant_id
      JOIN product_skus sku ON sku.id = v.sku_id
      JOIN customers c ON c.id = si.customer_id
      JOIN branches b ON b.id = si.branch_id
      WHERE ${this.where(f)}
      ORDER BY si.invoice_date DESC, si.invoice_number DESC
    `);
    return {
      lines: rows.map((r) => {
        const net = this.num(r.net), cogs = this.num(r.cogs);
        return {
          invoiceId: r.invoice_id, invoiceNumber: r.invoice_number, invoiceDate: r.invoice_date,
          invoiceWebRoute: `/sales/invoices?open=${r.invoice_id}`,
          customerName: r.customer_name, branchName: r.branch_name, productCode: r.product_code,
          boards: this.num(r.boards, 4), meters: this.num(r.meters, 4), lineNet: net,
          lineCogs: cogs, lineGrossProfit: new Decimal(net).minus(cogs).toFixed(2),
        };
      }),
    };
  }

  /** §8 — profitability with a switchable grouping dimension. */
  async profitability(f: ReportFilters, groupBy: "representative" | "branch" | "customer" | "product" | GroupBy) {
    const dim: Record<string, { key: Prisma.Sql; label: Prisma.Sql }> = {
      representative: { key: Prisma.raw("si.sales_representative_id::text"), label: Prisma.raw("coalesce(rep.name_ar, '— بدون مندوب —')") },
      branch:        { key: Prisma.raw("si.branch_id::text"),  label: Prisma.raw("b.name_ar") },
      customer:      { key: Prisma.raw("c.code"),               label: Prisma.raw("c.name_ar") },
      product:       { key: Prisma.raw("sku.code"),             label: Prisma.raw("sku.color_name_ar") },
      day:     { key: Prisma.raw(groupKeyExpr("day", "si.invoice_date")),     label: Prisma.raw(groupKeyExpr("day", "si.invoice_date")) },
      month:   { key: Prisma.raw(groupKeyExpr("month", "si.invoice_date")),   label: Prisma.raw(groupKeyExpr("month", "si.invoice_date")) },
      quarter: { key: Prisma.raw(groupKeyExpr("quarter", "si.invoice_date")), label: Prisma.raw(groupKeyExpr("quarter", "si.invoice_date")) },
      year:    { key: Prisma.raw(groupKeyExpr("year", "si.invoice_date")),    label: Prisma.raw(groupKeyExpr("year", "si.invoice_date")) },
    };
    const g = dim[groupBy]!;
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT ${g.key} AS grp_key, ${g.label} AS grp_label,
             ${Prisma.raw(M.invoices)} AS invoices, ${Prisma.raw(M.boards)} AS boards, ${Prisma.raw(M.meters)} AS meters,
             ${Prisma.raw(M.gross)} AS gross, ${Prisma.raw(M.discount)} AS discount,
             ${Prisma.raw(M.net)} AS net, ${Prisma.raw(M.cogs)} AS cogs
      FROM sales_invoices si
      JOIN sales_invoice_lines l ON l.invoice_id = si.id
      JOIN product_variants v ON v.id = l.product_variant_id
      JOIN product_skus sku ON sku.id = v.sku_id
      JOIN customers c ON c.id = si.customer_id
      JOIN branches b ON b.id = si.branch_id
      LEFT JOIN sales_representatives rep ON rep.id = si.sales_representative_id
      WHERE ${this.where(f)}
      GROUP BY grp_key, grp_label
      ORDER BY net DESC
    `);
    // Returns key expression parallel to the group dimension, on return aliases.
    const retDim: Record<string, Prisma.Sql> = {
      representative: Prisma.raw("sr.sales_representative_id::text"),
      branch:  Prisma.raw("sr.branch_id::text"),
      customer: Prisma.raw("c.code"),
      product: Prisma.raw("sku.code"),
      day:     Prisma.raw(groupKeyExpr("day", "sr.return_date")),
      month:   Prisma.raw(groupKeyExpr("month", "sr.return_date")),
      quarter: Prisma.raw(groupKeyExpr("quarter", "sr.return_date")),
      year:    Prisma.raw(groupKeyExpr("year", "sr.return_date")),
    };
    const retMap = await this.returnsByKey(f, retDim[groupBy]!);
    const groups = rows.map((r) => {
      const net = this.num(r.net), cogs = this.num(r.cogs);
      const base = {
        key: r.grp_key, label: r.grp_label, invoiceCount: Number(r.invoices),
        boards: this.num(r.boards, 4), metersSold: this.num(r.meters, 4), metersReturned: "0.0000", netMeters: this.num(r.meters, 4),
        grossSales: this.num(r.gross), discounts: this.num(r.discount), returns: "0.00", netSales: net,
        cogs, grossProfit: new Decimal(net).minus(cogs).toFixed(2),
      };
      return this.applyReturns(base, retMap.get(String(r.grp_key ?? "")));
    });
    return { from: f.from, to: f.to, groupBy, salesReturnsSupported: true, groups };
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
