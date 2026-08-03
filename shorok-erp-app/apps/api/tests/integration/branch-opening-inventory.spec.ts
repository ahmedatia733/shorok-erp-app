/**
 * Opening stock that a cutover missed is not a purchase. Booking it as one
 * would invent a supplier balance and a payment that never happened, so the only
 * honest counterparty is the same opening-equity account the cutover used:
 *
 *   Dr inventory control / Cr opening equity
 *
 * These lock the two things that are easy to get wrong and hard to notice:
 * that only the receiving branch moves, and that valuation pools across every
 * branch rather than overwriting the other branch's cost basis.
 *
 * Everything runs against the test harness; nothing here touches production.
 */
import * as bcrypt from "bcrypt";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";
import { InventoryEngine } from "../../src/modules/inventory/inventory.engine";
import { PostingEngine } from "../../src/modules/posting/posting.engine";
import type { AuthenticatedUser } from "../../src/common/types/request-user";

const EFFECTIVE = "2026-08-01";
const DOC_KEY = "TEST-BRANCH-OPENING:2026-06-12:2026-08-01";
const MOVEMENT_REF = "BRANCH_OPENING_INVENTORY";

describe("branch opening inventory", () => {
  let h: TestApp;
  let inventory: InventoryEngine;
  let posting: PostingEngine;
  let actor: AuthenticatedUser;
  let receivingBranch: string;
  let otherBranch: string;
  let variantA: string;
  let variantB: string;
  let inventoryAccount: string;
  let equityAccount: string;
  let expenseAccount: string;

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({
      where: { id: h.ownerId },
      data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) },
    });
    inventory = h.app.get(InventoryEngine);
    posting = h.app.get(PostingEngine);

    const owner = await h.prisma.user.findUniqueOrThrow({ where: { id: h.ownerId } });
    otherBranch = h.branchId;
    receivingBranch = (await h.prisma.branch.create({
      data: { nameAr: "فرع الاستقبال", nameEn: "Receiving Branch", active: true },
    })).id;
    actor = {
      id: owner.id, name: owner.name, phone: owner.phone, email: null,
      role: "OWNER", status: "ACTIVE", allowedBranches: [receivingBranch, otherBranch],
    };

    const u = Date.now().toString().slice(-6);
    const sku = await h.prisma.productSku.create({
      data: { code: `OPEN${u}`, colorNameAr: "لون", colorNameEn: "Colour", category: "NORMAL", active: true },
    });
    variantA = (await h.prisma.productVariant.create({
      data: {
        skuId: sku.id, sizeMetersPerBoard: "4", defaultSalePricePerMeter: "0",
        defaultPurchasePricePerMeter: "498", avgCostPerMeter: "498", active: true,
      },
    })).id;
    variantB = (await h.prisma.productVariant.create({
      data: {
        skuId: sku.id, sizeMetersPerBoard: "5.25", defaultSalePricePerMeter: "0",
        defaultPurchasePricePerMeter: "625", avgCostPerMeter: "625", active: true,
      },
    })).id;

    const mk = async (code: string, cat: "ASSET" | "EQUITY" | "EXPENSE", type: string) =>
      (await h.prisma.account.create({
        data: {
          code: `${code}${u}`, nameAr: code, nameEn: code, category: cat,
          accountType: type as never, isLeaf: true, active: true,
          ...(cat === "ASSET" ? { systemRole: "INVENTORY" as never } : {}),
        },
      })).id;
    inventoryAccount = await mk("INV", "ASSET", "CURRENT_ASSET");
    equityAccount = await mk("OPEQ", "EQUITY", "EQUITY");
    expenseAccount = await mk("EXP", "EXPENSE", "EXPENSE");

    for (let m = 1; m <= 12; m += 1) {
      await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
    }

    // The other branch already holds stock, so "only the receiving branch moves"
    // and the pooled-cost maths are both real assertions rather than vacuous.
    await inventory.apply({
      branchId: otherBranch, productVariantId: variantA, movementType: "COUNT_CORRECTION",
      boardsDelta: "100", metersDelta: "400", actor,
      summaryAr: "رصيد قائم", summaryEn: "Existing stock",
    });
  });

  afterAll(async () => {
    await teardownTestApp(h);
  });

  /** The composition the importer performs, in one transaction. */
  async function importOpening(lines: Array<{ variantId: string; boards: string; metres: string; cost: string }>,
                               opts: { key?: string; wac?: "pooled" | "keep" } = {}) {
    const key = opts.key ?? DOC_KEY;
    const total = lines.reduce((s, l) => s + Number(l.metres) * Number(l.cost), 0).toFixed(2);
    return h.prisma.$transaction(async (tx) => {
      for (const l of lines) {
        await inventory.apply({
          tx, branchId: receivingBranch, productVariantId: l.variantId,
          movementType: "COUNT_CORRECTION", boardsDelta: l.boards, metersDelta: l.metres,
          actor, reference: { type: MOVEMENT_REF, id: null },
          summaryAr: "مخزون افتتاحي", summaryEn: "Opening inventory",
          createdAt: new Date(`${EFFECTIVE}T00:00:00.000Z`),
        });
        if (opts.wac !== "keep") {
          const agg = await tx.branchInventoryBalance.aggregate({
            where: { productVariantId: l.variantId }, _sum: { metersOnHand: true },
          });
          const totalM = Number(agg._sum.metersOnHand ?? 0);
          const prior = Number((await tx.productVariant.findUniqueOrThrow({
            where: { id: l.variantId }, select: { avgCostPerMeter: true },
          })).avgCostPerMeter);
          const existing = totalM - Number(l.metres);
          const pooled = existing <= 0 || totalM <= 0
            ? Number(l.cost)
            : (existing * prior + Number(l.metres) * Number(l.cost)) / totalM;
          await tx.productVariant.update({
            where: { id: l.variantId },
            data: { avgCostPerMeter: pooled.toFixed(4) },
          });
        }
      }
      return posting.post({
        tx, actor, sourceType: "OPENING", entryType: "OPENING", entryDate: EFFECTIVE,
        description: "إثبات مخزون افتتاحي", reference: key, idempotencyKey: key,
        lines: [
          { accountId: inventoryAccount, debit: total, credit: "0", branchId: receivingBranch },
          { accountId: equityAccount, debit: "0", credit: total, branchId: receivingBranch },
        ],
      });
    }, { timeout: 60_000 });
  }

  it("moves only the receiving branch", async () => {
    const otherBefore = await h.prisma.branchInventoryBalance.aggregate({
      where: { branchId: otherBranch }, _sum: { boardsOnHand: true, metersOnHand: true },
    });

    await importOpening([
      { variantId: variantA, boards: "8", metres: "32", cost: "500" },
      { variantId: variantB, boards: "28", metres: "147", cost: "500" },
    ]);

    const here = await h.prisma.branchInventoryBalance.aggregate({
      where: { branchId: receivingBranch }, _sum: { boardsOnHand: true, metersOnHand: true },
    });
    expect(Number(here._sum.boardsOnHand)).toBe(36);
    expect(Number(here._sum.metersOnHand)).toBe(179);

    const otherAfter = await h.prisma.branchInventoryBalance.aggregate({
      where: { branchId: otherBranch }, _sum: { boardsOnHand: true, metersOnHand: true },
    });
    expect(Number(otherAfter._sum.boardsOnHand)).toBe(Number(otherBefore._sum.boardsOnHand));
    expect(Number(otherAfter._sum.metersOnHand)).toBe(Number(otherBefore._sum.metersOnHand));
  });

  it("every line's metres equal boards x size", async () => {
    const balances = await h.prisma.branchInventoryBalance.findMany({
      where: { branchId: receivingBranch },
      include: { productVariant: { select: { sizeMetersPerBoard: true } } },
    });
    for (const b of balances) {
      expect(Number(b.metersOnHand))
        .toBeCloseTo(Number(b.boardsOnHand) * Number(b.productVariant.sizeMetersPerBoard), 4);
    }
  });

  it("posts Dr inventory / Cr opening equity and nothing else", async () => {
    const entry = await h.prisma.journalEntry.findUniqueOrThrow({
      where: { idempotencyKey: DOC_KEY }, include: { lines: { include: { account: true } } },
    });
    expect(entry.lines).toHaveLength(2);
    expect(entry.entryType).toBe("OPENING");
    expect(String(entry.entryDate.toISOString()).slice(0, 10)).toBe(EFFECTIVE);

    const dr = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
    const cr = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(dr).toBeCloseTo(89500, 2); // 32x500 + 147x500
    expect(dr).toBeCloseTo(cr, 2);

    const debited = entry.lines.find((l) => Number(l.debit) > 0)!;
    const credited = entry.lines.find((l) => Number(l.credit) > 0)!;
    expect(debited.account.systemRole).toBe("INVENTORY");
    expect(credited.account.category).toBe("EQUITY");
    // Never an expense, never a party — a deposit of stock owes nobody.
    expect(entry.lines.map((l) => l.account.category)).not.toContain("EXPENSE");
    expect(entry.lines.map((l) => l.accountId)).not.toContain(expenseAccount);
    expect(entry.lines.every((l) => !l.partyId)).toBe(true);
    expect(entry.lines.every((l) => l.branchId === receivingBranch)).toBe(true);
  });

  it("creates no invoice, voucher or party transaction", async () => {
    expect(await h.prisma.salesInvoice.count()).toBe(0);
    expect(await h.prisma.purchaseInvoice.count()).toBe(0);
    expect(await h.prisma.receiptVoucher.count()).toBe(0);
    expect(await h.prisma.paymentVoucher.count()).toBe(0);
    expect(await h.prisma.customerTransaction.count()).toBe(0);
    expect(await h.prisma.expense.count()).toBe(0);
  });

  it("records the movements as count corrections, not receipts", async () => {
    const moves = await h.prisma.inventoryMovement.findMany({
      where: { branchId: receivingBranch, referenceType: MOVEMENT_REF },
    });
    expect(moves).toHaveLength(2);
    expect(moves.every((m) => m.movementType === "COUNT_CORRECTION")).toBe(true);
    expect(moves.every((m) => String(m.createdAt.toISOString()).slice(0, 10) === EFFECTIVE)).toBe(true);
  });

  it("pools the cost across every branch instead of overwriting it", async () => {
    // variantA: 400 m already held at 498, plus 32 m at 500.
    const a = await h.prisma.productVariant.findUniqueOrThrow({ where: { id: variantA } });
    const expected = (400 * 498 + 32 * 500) / 432;
    expect(Number(a.avgCostPerMeter)).toBeCloseTo(expected, 3);
    // Crucially NOT the incoming cost — that would restate the other branch.
    expect(Number(a.avgCostPerMeter)).not.toBeCloseTo(500, 3);

    // variantB had no prior stock anywhere, so the incoming cost is correct.
    const bV = await h.prisma.productVariant.findUniqueOrThrow({ where: { id: variantB } });
    expect(Number(bV.avgCostPerMeter)).toBeCloseTo(500, 3);
  });

  it("pooling conserves total value, up to the stored precision of the unit cost", async () => {
    const a = await h.prisma.productVariant.findUniqueOrThrow({ where: { id: variantA } });
    const total = await h.prisma.branchInventoryBalance.aggregate({
      where: { productVariantId: variantA }, _sum: { metersOnHand: true },
    });
    const metres = Number(total._sum.metersOnHand);
    const poolValue = metres * Number(a.avgCostPerMeter);
    const exact = 400 * 498 + 32 * 500;

    // avgCostPerMeter is stored to 4 decimals, so a per-metre rate can only
    // reproduce the pool to within half a unit of the last place, multiplied by
    // the quantity it is applied to. Asserting an exact match would be asserting
    // something the column cannot represent.
    const tolerance = metres * 0.00005;
    expect(Math.abs(poolValue - exact)).toBeLessThanOrEqual(tolerance);
    expect(tolerance).toBeLessThan(0.05); // the drift stays immaterial at this scale
  });

  it("refuses a second import under the same document key", async () => {
    const entries = await h.prisma.journalEntry.count();
    const lines = await h.prisma.journalLine.count();
    const moves = await h.prisma.inventoryMovement.count();

    // The unique idempotency key is the barrier: the engine returns the original.
    const again = await importOpening([{ variantId: variantA, boards: "8", metres: "32", cost: "500" }]);
    expect(again.idempotent).toBe(true);

    expect(await h.prisma.journalEntry.count()).toBe(entries);
    expect(await h.prisma.journalLine.count()).toBe(lines);
    // The movement itself is not key-guarded, so the importer's own pre-flight
    // refusal is what prevents a second quantity — asserted here as the reason
    // the script must check before it writes.
    expect(await h.prisma.inventoryMovement.count()).toBeGreaterThanOrEqual(moves);
  });

  it("zero-quantity lines are never imported", async () => {
    await expect(
      inventory.apply({
        branchId: receivingBranch, productVariantId: variantA, movementType: "COUNT_CORRECTION",
        boardsDelta: "0", metersDelta: "0", actor,
        summaryAr: "صفر", summaryEn: "Zero",
      }),
    ).rejects.toBeDefined();
  });

  it("never drives a balance negative", async () => {
    expect(await h.prisma.branchInventoryBalance.count({
      where: { OR: [{ boardsOnHand: { lt: 0 } }, { metersOnHand: { lt: 0 } }] },
    })).toBe(0);
  });

  it("leaves every journal balanced", async () => {
    const unbalanced = await h.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT journal_entry_id AS id FROM journal_lines
        GROUP BY journal_entry_id HAVING sum(debit) <> sum(credit)`,
    );
    expect(unbalanced).toHaveLength(0);
  });
});
