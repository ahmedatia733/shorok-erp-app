import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

interface Aggregates {
  branchId: string | null;
  totalSales: string;
  totalCollected: string;
  totalRemaining: string;
  totalExpenses: string;
  stockSummary: { boardsOnHand: string; metersOnHand: string };
  supplierBalances: Array<{
    supplierId: string;
    nameAr: string;
    nameEn: string;
    balance: string;
  }>;
  lowStock: Array<{
    branchId: string;
    productVariantId: string;
    boardsOnHand: string;
    metersOnHand: string;
    sku: { code: string; colorNameAr: string; colorNameEn: string };
    sizeMetersPerBoard: string;
  }>;
}

/**
 * T110 — Dashboard aggregator.
 *
 * Branch-scoped when `branchId` is provided; "all branches" otherwise.
 * Numbers stay as decimal strings end-to-end (no floats) so the totals
 * match the persisted Decimal columns exactly.
 *
 * Design notes:
 *   - sales/collected/remaining count only orders in the active states
 *     (CONFIRMED, PARTIALLY_COLLECTED, PAID). Drafts and cancelled
 *     orders are excluded by definition.
 *   - expenses sum is a signed sum (corrections are negative rows per
 *     US3) so refunds reduce the net total.
 *   - factory balances are per-supplier and read from the most recent
 *     ledger entry's running_balance (kept correct by every write).
 *   - factory balances are NOT branch-scoped — suppliers serve the
 *     business as a whole.
 *   - low-stock list compares each variant's per-branch on-hand boards
 *     against system_settings.low_stock_threshold_boards.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async aggregate(branchId: string | null): Promise<Aggregates> {
    const orderWhere: Prisma.CustomerOrderWhereInput = {
      status: { in: ["CONFIRMED", "PARTIALLY_COLLECTED", "PAID"] },
      ...(branchId ? { branchId } : {}),
    };

    const orders = await this.prisma.customerOrder.findMany({
      where: orderWhere,
      select: {
        id: true,
        requiredAmount: true,
        collections: { select: { amount: true } },
      },
    });

    let salesUnits = 0n; // numeric(14,2) → integer cents
    let collectedUnits = 0n;
    for (const o of orders) {
      salesUnits += toCents(o.requiredAmount);
      for (const c of o.collections) collectedUnits += toCents(c.amount);
    }
    const remainingUnits = salesUnits - collectedUnits;

    const expenseAgg = await this.prisma.expense.aggregate({
      where: branchId ? { branchId } : undefined,
      _sum: { amount: true },
    });
    const expensesUnits = toCents(expenseAgg._sum.amount ?? "0");

    const stockAgg = await this.prisma.branchInventoryBalance.aggregate({
      where: branchId ? { branchId } : undefined,
      _sum: { boardsOnHand: true, metersOnHand: true },
    });

    // Latest running_balance per supplier — DISTINCT ON is Postgres-specific
    // but the rest of the stack already requires Postgres.
    const supplierRows = await this.prisma.$queryRaw<
      Array<{ supplier_id: string; name_ar: string; name_en: string; running_balance: string }>
    >`
      SELECT DISTINCT ON (s.id)
        s.id          AS supplier_id,
        s.name_ar     AS name_ar,
        s.name_en     AS name_en,
        COALESCE(f.running_balance::text, '0') AS running_balance
      FROM suppliers s
      LEFT JOIN factory_ledger_entries f ON f.supplier_id = s.id
      WHERE s.active = true
      ORDER BY s.id, f.order_date DESC NULLS LAST, f.created_at DESC NULLS LAST
    `;

    const settings = await this.prisma.systemSettings.findUniqueOrThrow({
      where: { id: 1 },
      select: { lowStockThresholdBoards: true },
    });
    const threshold = settings.lowStockThresholdBoards;

    const lowStock = await this.prisma.branchInventoryBalance.findMany({
      where: {
        ...(branchId ? { branchId } : {}),
        boardsOnHand: { lt: threshold },
      },
      include: {
        productVariant: { include: { sku: true } },
      },
      orderBy: [{ boardsOnHand: "asc" }],
      take: 50,
    });

    return {
      branchId,
      totalSales: fromCents(salesUnits),
      totalCollected: fromCents(collectedUnits),
      totalRemaining: fromCents(remainingUnits),
      totalExpenses: fromCents(expensesUnits),
      stockSummary: {
        boardsOnHand: (stockAgg._sum.boardsOnHand ?? "0").toString(),
        metersOnHand: (stockAgg._sum.metersOnHand ?? "0").toString(),
      },
      supplierBalances: supplierRows.map((r) => ({
        supplierId: r.supplier_id,
        nameAr: r.name_ar,
        nameEn: r.name_en,
        balance: r.running_balance,
      })),
      lowStock: lowStock.map((b) => ({
        branchId: b.branchId,
        productVariantId: b.productVariantId,
        boardsOnHand: b.boardsOnHand.toString(),
        metersOnHand: b.metersOnHand.toString(),
        sku: {
          code: b.productVariant.sku.code,
          colorNameAr: b.productVariant.sku.colorNameAr,
          colorNameEn: b.productVariant.sku.colorNameEn,
        },
        sizeMetersPerBoard: b.productVariant.sizeMetersPerBoard.toString(),
      })),
    };
  }
}

/**
 * Convert a numeric(14,2) Prisma Decimal (or string) into integer cents
 * BigInt — keeps additions exact across thousands of rows without any
 * float arithmetic and without dragging in decimal.js for one helper.
 */
function toCents(v: Prisma.Decimal | string | number): bigint {
  const s = typeof v === "string" ? v : v.toString();
  const negative = s.startsWith("-");
  const u = negative ? s.slice(1) : s;
  const [whole, frac = ""] = u.split(".");
  const fracPadded = (frac + "00").slice(0, 2);
  const cents = BigInt((whole ?? "0") + fracPadded);
  return negative ? -cents : cents;
}

function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const fracStr = rem.toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fracStr}`;
}
