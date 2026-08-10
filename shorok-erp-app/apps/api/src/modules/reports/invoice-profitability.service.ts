import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
/* PrismaService is injected, so it must stay a VALUE import for Nest's
   decorator metadata; `Prisma` is used as a value too (Prisma.sql). */
/* eslint-disable-next-line @typescript-eslint/consistent-type-imports */
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { LINE_COGS_EXPR, LINE_HAS_COST_EXPR, M } from "./sales-metrics";
import type { ReportFilters } from "./sales-rep-reports.service";

/**
 * تقرير ربحية الفواتير — what each sale actually earned.
 *
 * Strictly read-only: every method here issues SELECTs and nothing else. The
 * report derives entirely from data the ERP already persisted when the invoice
 * was posted; it stores no snapshot, caches no row, and writes no audit trail.
 *
 * ── What "profit" means here ──────────────────────────────────────────────
 *
 *   صافي المبيعات بدون الضريبة − تكلفة البضاعة المباعة = إجمالي الربح
 *
 * This is GROSS invoice profit. VAT is not revenue — it is collected on the
 * state's behalf — so it never enters the calculation, and operating expenses
 * (rent, salaries, transport) are not allocated to invoices. Those belong to a
 * company-level P&L, not to the question "did this sale make money".
 *
 * ── Which invoices count ──────────────────────────────────────────────────
 *
 * Only `status = 'CONFIRMED'`. A DRAFT has not economically happened, and
 * cancelling an invoice reverses its journals but deliberately leaves the
 * document's totals intact, so including CANCELLED rows would inflate both
 * revenue and cost with no visible error.
 *
 * A revised invoice is NOT double counted: revision rewrites the invoice and its
 * lines in place, so the row IS the current economic state. There is no
 * superseded copy to exclude and `sales_invoice_revisions` is an audit spine,
 * never a version of record — joining it would multiply rows by revision count.
 *
 * ── Cost, and the honesty problem ─────────────────────────────────────────
 *
 * COGS is the snapshot stamped at posting, never today's moving average: an
 * invoice sold at 475 stays at 475 after stock rises to 520. But some legacy
 * lines predate cost snapshots entirely, and the usual fallback resolves those
 * to 0 — which reads as "cost nothing" and prints a 100% margin.
 *
 * So every line is classified, and an invoice missing any line's cost is
 * reported with its sales visible and its cost, profit and margin explicitly
 * UNAVAILABLE rather than guessed. Cost is never recovered from the current
 * average, the last purchase price, or the catalogue: none of those is what the
 * goods actually cost, and a plausible number would be worse than an absent one
 * because it would be believed.
 *
 * Consequently the summary reports revenue over ALL confirmed invoices, but
 * cost and profit over the cost-complete subset only, and says how much revenue
 * it had to leave out. Every aggregate follows the same split, so the tabs
 * always reconcile with the invoice list.
 *
 * ── Returns ───────────────────────────────────────────────────────────────
 *
 * Only CONFIRMED sales returns that are authoritatively linked to the original
 * invoice (`original_sales_invoice_id`) are subtracted, using the return's own
 * persisted historical cost reversal. Returns are counted all-time against the
 * invoice they belong to — the question being answered is "what did THIS invoice
 * finally earn", not "what happened during this period".
 *
 * «مردودات بدون فواتير» are deliberately excluded: a legacy return carries no
 * reliable link to an electronic invoice, and matching one by customer, price or
 * date would be a guess attached to a specific customer's profit figure.
 */

/** How much of an invoice's cost the ERP actually recorded. */
export type CostCoverage = "COMPLETE" | "PARTIAL" | "MISSING";

export interface ProfitabilityOptions {
  invoiceNumber?: string;
  /** Restrict to invoices whose cost data is complete / incomplete. */
  costCoverage?: "ALL" | "COMPLETE" | "INCOMPLETE";
  /** One specific invoice, for the drill-down. */
  invoiceId?: string;
  page?: number;
  pageSize?: number;
}

const D = (v: unknown): Decimal => new Decimal((v as { toString(): string } | null)?.toString() ?? "0");

/** grossProfit / netSales × 100, or null when there is nothing to divide by. */
function marginPct(profit: Decimal, net: Decimal): string | null {
  if (!net.isFinite() || net.lte(0)) return null;
  return profit.div(net).mul(100).toFixed(2);
}

interface ReturnAgg {
  net: Decimal;
  cogs: Decimal;
  meters: Decimal;
  boards: Decimal;
}
const ZERO_RETURN: ReturnAgg = { net: new Decimal(0), cogs: new Decimal(0), meters: new Decimal(0), boards: new Decimal(0) };

@Injectable()
export class InvoiceProfitabilityService {
  constructor(private readonly prisma: PrismaService) {}

  private num = (v: unknown, dp = 2) => D(v).toFixed(dp);

  /**
   * The CONFIRMED-invoice predicate plus the caller's filters, on alias `si`
   * (invoice), `l` (line) and `sku` (product).
   *
   * `allowedBranchIds` is the server-side branch scope: a non-OWNER never sees
   * another branch's margins, and the restriction is applied in SQL rather than
   * trusted to the client.
   */
  private where(f: ReportFilters, o: ProfitabilityOptions = {}): Prisma.Sql {
    const parts: Prisma.Sql[] = [
      Prisma.sql`si.status = 'CONFIRMED'`,
      Prisma.sql`si.invoice_date BETWEEN ${f.from}::date AND ${f.to}::date`,
    ];
    if (f.salesRepresentativeId) parts.push(Prisma.sql`si.sales_representative_id = ${f.salesRepresentativeId}::uuid`);
    if (f.branchId) parts.push(Prisma.sql`si.branch_id = ${f.branchId}::uuid`);
    if (f.allowedBranchIds) {
      parts.push(
        f.allowedBranchIds.length
          ? Prisma.sql`si.branch_id IN (${Prisma.join(f.allowedBranchIds.map((b) => Prisma.sql`${b}::uuid`))})`
          : Prisma.sql`false`,
      );
    }
    if (f.customerId) parts.push(Prisma.sql`si.customer_id = ${f.customerId}::uuid`);
    if (f.productVariantId) parts.push(Prisma.sql`l.product_variant_id = ${f.productVariantId}::uuid`);
    if (f.productCode) parts.push(Prisma.sql`sku.code = ${f.productCode}`);
    if (f.productNameAr) parts.push(Prisma.sql`sku.color_name_ar ILIKE ${"%" + f.productNameAr + "%"}`);
    if (o.invoiceNumber) parts.push(Prisma.sql`si.invoice_number::text ILIKE ${"%" + o.invoiceNumber + "%"}`);
    if (o.invoiceId) parts.push(Prisma.sql`si.id = ${o.invoiceId}::uuid`);
    return Prisma.join(parts, " AND ");
  }

  /**
   * Confirmed linked returns for the invoices in scope, keyed by original
   * invoice id.
   *
   * The join is on `original_sales_invoice_id` only — the authoritative link. A
   * return without one cannot be attributed to an invoice and is left out
   * rather than guessed onto the nearest candidate.
   */
  private async returnsByInvoice(f: ReportFilters, o: ProfitabilityOptions = {}): Promise<Map<string, ReturnAgg>> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT sr.original_sales_invoice_id::text AS invoice_id,
             coalesce(sum(rl.return_net_ex_tax), 0)          AS ret_net,
             coalesce(sum(rl.return_cogs), 0)                AS ret_cogs,
             coalesce(sum(rl.returned_meters_quantity), 0)   AS ret_meters,
             coalesce(sum(rl.returned_boards), 0)            AS ret_boards
      FROM sales_returns sr
      JOIN sales_return_lines rl ON rl.sales_return_id = sr.id
      WHERE sr.status = 'CONFIRMED'
        AND sr.original_sales_invoice_id IN (
          SELECT si.id
          FROM sales_invoices si
          JOIN sales_invoice_lines l ON l.invoice_id = si.id
          JOIN product_variants v ON v.id = l.product_variant_id
          JOIN product_skus sku ON sku.id = v.sku_id
          WHERE ${this.where(f, o)}
        )
      GROUP BY sr.original_sales_invoice_id
    `);
    return new Map(
      rows.map((r) => [
        String(r.invoice_id),
        { net: D(r.ret_net), cogs: D(r.ret_cogs), meters: D(r.ret_meters), boards: D(r.ret_boards) },
      ]),
    );
  }

  /** One row per confirmed invoice, with its cost coverage decided in SQL. */
  private invoiceRowsSql(f: ReportFilters, o: ProfitabilityOptions): Prisma.Sql {
    return Prisma.sql`
      SELECT si.id::text AS id,
             si.invoice_number::text AS invoice_number,
             si.invoice_date::text   AS invoice_date,
             si.status,
             si.revision_number,
             c.code AS customer_code, c.name_ar AS customer_name,
             b.name_ar AS branch_name,
             rep.name_ar AS rep_name,
             si.subtotal, si.tax_amount, si.grand_total, si.tax_rate,
             ${Prisma.raw(M.gross)}    AS gross,
             ${Prisma.raw(M.discount)} AS discount,
             ${Prisma.raw(M.net)}      AS net,
             ${Prisma.raw(M.cogs)}     AS cogs,
             ${Prisma.raw(M.boards)}   AS boards,
             ${Prisma.raw(M.meters)}   AS meters,
             count(*)                                   AS line_count,
             ${Prisma.raw(M.missingCostLines)}          AS missing_cost_lines
      FROM sales_invoices si
      JOIN sales_invoice_lines l ON l.invoice_id = si.id
      JOIN product_variants v ON v.id = l.product_variant_id
      JOIN product_skus sku ON sku.id = v.sku_id
      JOIN customers c ON c.id = si.customer_id
      JOIN branches b ON b.id = si.branch_id
      LEFT JOIN sales_representatives rep ON rep.id = si.sales_representative_id
      WHERE ${this.where(f, o)}
      GROUP BY si.id, si.invoice_number, si.invoice_date, si.status, si.revision_number,
               c.code, c.name_ar, b.name_ar, rep.name_ar,
               si.subtotal, si.tax_amount, si.grand_total, si.tax_rate
    `;
  }

  private coverageOf(lineCount: number, missing: number): CostCoverage {
    if (missing === 0) return "COMPLETE";
    return missing >= lineCount ? "MISSING" : "PARTIAL";
  }

  /**
   * Build one invoice row.
   *
   * When cost coverage is not COMPLETE the cost and profit fields are `null` —
   * genuinely unknown, and shown as «غير متاحة» rather than as a confident
   * zero. Sales figures stay visible either way; those are known.
   */
  private invoiceRow(r: Record<string, unknown>, ret: ReturnAgg) {
    const lineCount = Number(r.line_count ?? 0);
    const missing = Number(r.missing_cost_lines ?? 0);
    const coverage = this.coverageOf(lineCount, missing);
    const complete = coverage === "COMPLETE";

    const net = D(r.net);
    const cogs = D(r.cogs);
    const grossProfit = net.minus(cogs);
    const finalNet = net.minus(ret.net);
    const finalCogs = cogs.minus(ret.cogs);
    const finalProfit = finalNet.minus(finalCogs);

    return {
      id: String(r.id),
      invoiceNumber: String(r.invoice_number),
      invoiceDate: String(r.invoice_date),
      status: String(r.status),
      revisionNumber: Number(r.revision_number ?? 1),
      customerCode: (r.customer_code as string) ?? null,
      customerName: (r.customer_name as string) ?? null,
      branchName: (r.branch_name as string) ?? null,
      salesRepresentativeName: (r.rep_name as string) ?? null,

      boards: this.num(r.boards, 4),
      meters: this.num(r.meters, 4),
      salesBeforeDiscount: this.num(r.gross),
      discount: this.num(r.discount),
      netSalesExVat: net.toFixed(2),
      tax: this.num(r.tax_amount),
      grandTotal: this.num(r.grand_total),

      cogs: complete ? cogs.toFixed(2) : null,
      grossProfit: complete ? grossProfit.toFixed(2) : null,
      marginPct: complete ? marginPct(grossProfit, net) : null,

      returnNetExVat: ret.net.toFixed(2),
      returnCogs: complete ? ret.cogs.toFixed(2) : null,
      returnedMeters: ret.meters.toFixed(4),
      finalNetSalesExVat: finalNet.toFixed(2),
      finalCogs: complete ? finalCogs.toFixed(2) : null,
      finalProfit: complete ? finalProfit.toFixed(2) : null,
      finalMarginPct: complete ? marginPct(finalProfit, finalNet) : null,

      costCoverage: coverage,
      lineCount,
      linesMissingCost: missing,
    };
  }

  /**
   * The report: summary cards + one page of invoice rows.
   *
   * Revenue totals cover every confirmed invoice in scope. Cost and profit
   * totals cover only the cost-complete ones, and `incompleteCost*` says
   * exactly how much revenue that leaves unaccounted — so the reader can see
   * the confidence of the profit number instead of inferring it.
   */
  async report(f: ReportFilters, o: ProfitabilityOptions = {}) {
    const page = Math.max(1, o.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, o.pageSize ?? 50));

    const [all, returns] = await Promise.all([
      this.prisma.$queryRaw<Array<Record<string, unknown>>>(this.invoiceRowsSql(f, o)),
      this.returnsByInvoice(f, o),
    ]);

    let rows = all.map((r) => this.invoiceRow(r, returns.get(String(r.id)) ?? ZERO_RETURN));
    if (o.costCoverage === "COMPLETE") rows = rows.filter((r) => r.costCoverage === "COMPLETE");
    if (o.costCoverage === "INCOMPLETE") rows = rows.filter((r) => r.costCoverage !== "COMPLETE");

    rows.sort((a, b) =>
      a.invoiceDate === b.invoiceDate
        ? Number(b.invoiceNumber) - Number(a.invoiceNumber)
        : a.invoiceDate < b.invoiceDate ? 1 : -1,
    );

    return {
      from: f.from,
      to: f.to,
      summary: this.summarize(rows),
      invoices: rows.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      totalInvoices: rows.length,
    };
  }

  /** Summary cards. Sales over everything; cost and profit over what is known. */
  private summarize(rows: ReturnType<InvoiceProfitabilityService["invoiceRow"]>[]) {
    const complete = rows.filter((r) => r.costCoverage === "COMPLETE");
    const sum = (xs: string[]) => xs.reduce((a, v) => a.plus(v), new Decimal(0));

    const netSales = sum(rows.map((r) => r.netSalesExVat));
    const costedNet = sum(complete.map((r) => r.netSalesExVat));
    const cogs = sum(complete.map((r) => r.cogs ?? "0"));
    const grossProfit = costedNet.minus(cogs);

    const returnsNet = sum(rows.map((r) => r.returnNetExVat));
    const costedReturnsNet = sum(complete.map((r) => r.returnNetExVat));
    const returnsCogs = sum(complete.map((r) => r.returnCogs ?? "0"));

    const finalNet = netSales.minus(returnsNet);
    const costedFinalNet = costedNet.minus(costedReturnsNet);
    const finalCogs = cogs.minus(returnsCogs);
    const finalProfit = costedFinalNet.minus(finalCogs);

    return {
      invoiceCount: rows.length,
      netSalesExVat: netSales.toFixed(2),
      tax: sum(rows.map((r) => r.tax)).toFixed(2),
      grandTotal: sum(rows.map((r) => r.grandTotal)).toFixed(2),

      // Confirmed profitability — the cost-complete population only.
      costedInvoiceCount: complete.length,
      costedNetSalesExVat: costedNet.toFixed(2),
      historicalCogs: cogs.toFixed(2),
      grossProfit: grossProfit.toFixed(2),
      grossMarginPct: marginPct(grossProfit, costedNet),

      linkedReturnsNetExVat: returnsNet.toFixed(2),
      linkedReturnsCogs: returnsCogs.toFixed(2),
      finalNetSalesExVat: finalNet.toFixed(2),
      finalCogs: finalCogs.toFixed(2),
      finalGrossProfit: finalProfit.toFixed(2),
      finalGrossMarginPct: marginPct(finalProfit, costedFinalNet),

      // What the profit figures had to leave out, stated rather than implied.
      incompleteCostInvoiceCount: rows.length - complete.length,
      incompleteCostNetSales: netSales.minus(costedNet).toFixed(2),
    };
  }

  /**
   * The aggregation tabs, all from one query per dimension.
   *
   * Cost and profit are summed only over lines belonging to cost-complete
   * invoices, exactly as the summary does, so a product/customer/branch total
   * always reconciles with the invoice list rather than quietly counting an
   * absent cost as zero.
   */
  async aggregates(f: ReportFilters, o: ProfitabilityOptions = {}) {
    const dims = {
      product: { key: Prisma.raw("sku.code"), label: Prisma.raw("sku.color_name_ar") },
      customer: { key: Prisma.raw("c.code"), label: Prisma.raw("c.name_ar") },
      branch: { key: Prisma.raw("b.id::text"), label: Prisma.raw("b.name_ar") },
      representative: {
        key: Prisma.raw("coalesce(si.sales_representative_id::text, '')"),
        label: Prisma.raw("coalesce(rep.name_ar, '— بدون مندوب —')"),
      },
    } as const;

    const entries = await Promise.all(
      (Object.keys(dims) as Array<keyof typeof dims>).map(async (dim) => [dim, await this.aggregate(f, o, dims[dim])] as const),
    );
    return Object.fromEntries(entries) as Record<keyof typeof dims, Awaited<ReturnType<InvoiceProfitabilityService["aggregate"]>>>;
  }

  private async aggregate(f: ReportFilters, o: ProfitabilityOptions, g: { key: Prisma.Sql; label: Prisma.Sql }) {
    // `complete_invoices` is the cost-complete population, decided once and
    // reused for the costed sums so every tab agrees with the invoice list.
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      WITH complete_invoices AS (
        SELECT si.id
        FROM sales_invoices si
        JOIN sales_invoice_lines l ON l.invoice_id = si.id
        JOIN product_variants v ON v.id = l.product_variant_id
        JOIN product_skus sku ON sku.id = v.sku_id
        WHERE ${this.where(f, o)}
        GROUP BY si.id
        HAVING ${Prisma.raw(M.missingCostLines)} = 0
      )
      SELECT ${g.key} AS grp_key, ${g.label} AS grp_label,
             ${Prisma.raw(M.invoices)} AS invoices,
             ${Prisma.raw(M.boards)}   AS boards,
             ${Prisma.raw(M.meters)}   AS meters,
             ${Prisma.raw(M.gross)}    AS gross,
             ${Prisma.raw(M.discount)} AS discount,
             ${Prisma.raw(M.net)}      AS net,
             coalesce(sum(l.line_total) FILTER (WHERE ci.id IS NOT NULL), 0) AS costed_net,
             coalesce(sum(${Prisma.raw(LINE_COGS_EXPR)}) FILTER (WHERE ci.id IS NOT NULL), 0) AS cogs,
             count(distinct si.id) FILTER (WHERE ci.id IS NULL) AS incomplete_invoices,
             ${Prisma.raw(M.missingCostLines)} AS missing_cost_lines
      FROM sales_invoices si
      JOIN sales_invoice_lines l ON l.invoice_id = si.id
      JOIN product_variants v ON v.id = l.product_variant_id
      JOIN product_skus sku ON sku.id = v.sku_id
      JOIN customers c ON c.id = si.customer_id
      JOIN branches b ON b.id = si.branch_id
      LEFT JOIN sales_representatives rep ON rep.id = si.sales_representative_id
      LEFT JOIN complete_invoices ci ON ci.id = si.id
      WHERE ${this.where(f, o)}
      GROUP BY grp_key, grp_label
      ORDER BY net DESC
    `);

    // Returns, netted onto the same dimension. Only linked confirmed returns,
    // and only against invoices whose cost is complete — otherwise a return's
    // cost reversal would be subtracted from a COGS total it was never in.
    const retRows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      WITH scoped AS (
        SELECT si.id,
               ${g.key} AS grp_key,
               (count(*) FILTER (WHERE NOT ${Prisma.raw(LINE_HAS_COST_EXPR)}) = 0) AS cost_complete
        FROM sales_invoices si
        JOIN sales_invoice_lines l ON l.invoice_id = si.id
        JOIN product_variants v ON v.id = l.product_variant_id
        JOIN product_skus sku ON sku.id = v.sku_id
        JOIN customers c ON c.id = si.customer_id
        JOIN branches b ON b.id = si.branch_id
        LEFT JOIN sales_representatives rep ON rep.id = si.sales_representative_id
        WHERE ${this.where(f, o)}
        GROUP BY si.id, grp_key
      )
      SELECT s.grp_key,
             coalesce(sum(rl.return_net_ex_tax), 0) AS ret_net,
             coalesce(sum(rl.return_cogs) FILTER (WHERE s.cost_complete), 0) AS ret_cogs,
             coalesce(sum(rl.return_net_ex_tax) FILTER (WHERE s.cost_complete), 0) AS costed_ret_net,
             coalesce(sum(rl.returned_meters_quantity), 0) AS ret_meters
      FROM scoped s
      JOIN sales_returns sr ON sr.original_sales_invoice_id = s.id AND sr.status = 'CONFIRMED'
      JOIN sales_return_lines rl ON rl.sales_return_id = sr.id
      GROUP BY s.grp_key
    `);
    const ret = new Map(retRows.map((r) => [String(r.grp_key ?? ""), r]));

    return rows.map((r) => {
      const key = String(r.grp_key ?? "");
      const rr = ret.get(key);
      const net = D(r.net);
      const costedNet = D(r.costed_net);
      const cogs = D(r.cogs);

      const retNet = D(rr?.ret_net);
      const retCogs = D(rr?.ret_cogs);
      const costedRetNet = D(rr?.costed_ret_net);

      const grossProfit = costedNet.minus(cogs);
      const finalCostedNet = costedNet.minus(costedRetNet);
      const finalCogs = cogs.minus(retCogs);
      const finalProfit = finalCostedNet.minus(finalCogs);
      const incomplete = Number(r.incomplete_invoices ?? 0);

      return {
        key,
        label: (r.grp_label as string) ?? key,
        invoiceCount: Number(r.invoices ?? 0),
        boards: this.num(r.boards, 4),
        meters: this.num(r.meters, 4),
        salesBeforeDiscount: this.num(r.gross),
        discount: this.num(r.discount),
        netSalesExVat: net.toFixed(2),

        costedNetSalesExVat: costedNet.toFixed(2),
        cogs: cogs.toFixed(2),
        grossProfit: grossProfit.toFixed(2),
        marginPct: marginPct(grossProfit, costedNet),

        returnNetExVat: retNet.toFixed(2),
        returnCogs: retCogs.toFixed(2),
        returnedMeters: this.num(rr?.ret_meters, 4),
        finalNetSalesExVat: net.minus(retNet).toFixed(2),
        finalCogs: finalCogs.toFixed(2),
        finalProfit: finalProfit.toFixed(2),
        finalMarginPct: marginPct(finalProfit, finalCostedNet),

        incompleteCostInvoiceCount: incomplete,
        linesMissingCost: Number(r.missing_cost_lines ?? 0),
      };
    });
  }

  /**
   * One invoice, line by line.
   *
   * Product code/name and variant size are resolved live from the catalogue —
   * the same thing the invoice screen does — while every quantity, price and
   * cost comes from the line's own persisted values. Renaming a product must
   * never restate what a past sale earned.
   */
  async invoiceDetail(f: ReportFilters, invoiceId: string) {
    // Addressed by id, and deliberately without the caller's date window: a
    // drill-down opens the invoice you clicked, not "the invoice if it happens
    // to fall inside the current filter". Branch scope still applies.
    const header = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(
      this.invoiceRowsSql(
        { from: "1900-01-01", to: "2999-12-31", allowedBranchIds: f.allowedBranchIds },
        { invoiceId },
      ),
    );
    const head = header[0];
    if (!head) return null;

    const lines = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT l.id::text AS id,
             sku.code AS product_code, sku.color_name_ar AS product_name,
             v.id::text AS variant_id, v.size_meters_per_board::text AS variant_size,
             l.length_m::text AS length_m, l.width_m::text AS width_m,
             l.quantity AS boards, l.meters_quantity AS meters,
             l.unit_price, l.discount_pct,
             (l.meters_quantity * l.unit_price - l.line_total) AS discount,
             l.line_total AS net,
             l.tax_rate_at_posting,
             l.unit_cost_per_meter_at_posting::text AS cost_per_meter,
             l.unit_cost_at_posting AS cost_per_board,
             ${Prisma.raw(LINE_COGS_EXPR)} AS line_cogs,
             ${Prisma.raw(LINE_HAS_COST_EXPR)} AS has_cost
      FROM sales_invoice_lines l
      JOIN product_variants v ON v.id = l.product_variant_id
      JOIN product_skus sku ON sku.id = v.sku_id
      WHERE l.invoice_id = ${invoiceId}::uuid
      ORDER BY l.id
    `);

    // Confirmed returns booked against this invoice, resolved to the exact
    // original line so a line can show what came back and at what cost.
    const retLines = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT rl.original_sales_invoice_line_id::text AS line_id,
             coalesce(sum(rl.returned_boards), 0) AS boards,
             coalesce(sum(rl.returned_meters_quantity), 0) AS meters,
             coalesce(sum(rl.return_net_ex_tax), 0) AS net,
             coalesce(sum(rl.return_cogs), 0) AS cogs
      FROM sales_returns sr
      JOIN sales_return_lines rl ON rl.sales_return_id = sr.id
      WHERE sr.status = 'CONFIRMED' AND sr.original_sales_invoice_id = ${invoiceId}::uuid
      GROUP BY rl.original_sales_invoice_line_id
    `);
    const retByLine = new Map(retLines.map((r) => [String(r.line_id), r]));

    const returns = await this.returnDocuments(invoiceId);
    const invoiceReturn = returns.reduce<ReturnAgg>(
      (a, r) => ({
        net: a.net.plus(r.netExVat),
        cogs: a.cogs.plus(r.cogs),
        meters: a.meters.plus(r.meters),
        boards: a.boards.plus(r.boards),
      }),
      ZERO_RETURN,
    );

    return {
      invoice: this.invoiceRow(head, invoiceReturn),
      lines: lines.map((r) => {
        const hasCost = r.has_cost === true;
        const net = D(r.net);
        const cogs = D(r.line_cogs);
        const profit = net.minus(cogs);
        const rr = retByLine.get(String(r.id));
        const retNet = D(rr?.net);
        const retCogs = D(rr?.cogs);
        const finalNet = net.minus(retNet);
        const finalCogs = cogs.minus(retCogs);

        // كبير / صغير / مقاس مخصص — the size actually sold, from the line.
        const sizeMode = r.width_m != null
          ? "CUSTOM"
          : r.length_m != null
            ? (D(r.length_m).eq("5.25") ? "LARGE" : D(r.length_m).eq("4") ? "SMALL" : "CUSTOM")
            : "DEFAULT";

        return {
          id: String(r.id),
          productCode: r.product_code as string,
          productName: r.product_name as string,
          productVariantId: String(r.variant_id),
          variantSize: this.num(r.variant_size, 4),
          sizeMode,
          lengthM: r.length_m != null ? this.num(r.length_m, 4) : null,
          widthM: r.width_m != null ? this.num(r.width_m, 4) : null,
          boards: this.num(r.boards, 4),
          meters: this.num(r.meters, 4),
          salePricePerMeter: this.num(r.unit_price),
          discountPct: this.num(r.discount_pct),
          discount: this.num(r.discount),
          netSalesExVat: net.toFixed(2),
          taxRate: r.tax_rate_at_posting != null ? this.num(r.tax_rate_at_posting) : null,

          costPerMeterAtPosting: r.cost_per_meter != null ? this.num(r.cost_per_meter, 4) : null,
          costPerBoardAtPosting: r.cost_per_board != null ? this.num(r.cost_per_board) : null,
          cogs: hasCost ? cogs.toFixed(2) : null,
          grossProfit: hasCost ? profit.toFixed(2) : null,
          marginPct: hasCost ? marginPct(profit, net) : null,

          returnedBoards: this.num(rr?.boards, 4),
          returnedMeters: this.num(rr?.meters, 4),
          returnNetExVat: retNet.toFixed(2),
          returnCogs: hasCost ? retCogs.toFixed(2) : null,
          finalNetSalesExVat: finalNet.toFixed(2),
          finalCogs: hasCost ? finalCogs.toFixed(2) : null,
          finalProfit: hasCost ? finalNet.minus(finalCogs).toFixed(2) : null,

          costBasis: r.cost_per_meter != null
            ? "METER_SNAPSHOT"
            : hasCost ? "LEGACY_BOARD" : "MISSING",
        };
      }),
      returns: returns.map((r) => ({
        id: r.id,
        returnNumber: r.returnNumber,
        returnDate: r.returnDate,
        netExVat: r.netExVat.toFixed(2),
        cogs: r.cogs.toFixed(2),
        meters: r.meters.toFixed(4),
        boards: r.boards.toFixed(4),
      })),
    };
  }

  /** The confirmed return documents linked to one invoice. */
  private async returnDocuments(invoiceId: string) {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT sr.id::text AS id, sr.return_number::text AS return_number,
             sr.return_date::text AS return_date,
             coalesce(sum(rl.return_net_ex_tax), 0) AS net,
             coalesce(sum(rl.return_cogs), 0) AS cogs,
             coalesce(sum(rl.returned_meters_quantity), 0) AS meters,
             coalesce(sum(rl.returned_boards), 0) AS boards
      FROM sales_returns sr
      JOIN sales_return_lines rl ON rl.sales_return_id = sr.id
      WHERE sr.status = 'CONFIRMED' AND sr.original_sales_invoice_id = ${invoiceId}::uuid
      GROUP BY sr.id, sr.return_number, sr.return_date
      ORDER BY sr.return_date DESC
    `);
    return rows.map((r) => ({
      id: String(r.id),
      returnNumber: String(r.return_number),
      returnDate: String(r.return_date),
      netExVat: D(r.net),
      cogs: D(r.cogs),
      meters: D(r.meters),
      boards: D(r.boards),
    }));
  }
}
