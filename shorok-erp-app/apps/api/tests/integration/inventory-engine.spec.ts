/**
 * T061 — InventoryEngine integration test.
 *
 * Proves the non-negative invariant under all three threat models the
 * constitution names:
 *   (a) sequential receipt → over-sale (engine-level rejection)
 *   (b) two parallel sales racing the same balance (FOR UPDATE serialization)
 *   (c) DB CHECK rejects a bypass attempt (defense in depth)
 */
import { InventoryEngine } from "../../src/modules/inventory/inventory.engine";
import { InsufficientStockError } from "../../src/common/errors/api-errors";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";
import type { AuthenticatedUser } from "../../src/common/types/request-user";

describe("InventoryEngine — non-negative invariant", () => {
  let handle: TestApp;
  let engine: InventoryEngine;
  let actor: AuthenticatedUser;
  let variantId: string;

  beforeAll(async () => {
    handle = await buildTestApp();
    engine = handle.app.get(InventoryEngine);
    actor = {
      id: handle.ownerId,
      name: "Test Owner",
      phone: handle.ownerPhone,
      email: null,
      role: "OWNER",
      status: "ACTIVE",
      allowedBranches: [handle.branchId],
    };

    const sku = await handle.prisma.productSku.create({
      data: { code: "ENG-T1", colorNameAr: "اختبار", colorNameEn: "Engine Test", category: "NORMAL" },
    });
    const variant = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "4",
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "80",
      },
    });
    variantId = variant.id;
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  async function readBalance() {
    return handle.prisma.branchInventoryBalance.findUnique({
      where: {
        branchId_productVariantId: { branchId: handle.branchId, productVariantId: variantId },
      },
    });
  }

  it("(a) receipt followed by an over-sale rejects with InsufficientStockError", async () => {
    await engine.apply({
      branchId: handle.branchId,
      productVariantId: variantId,
      movementType: "RECEIPT",
      boardsDelta: "5",
      actor,
      summaryAr: "ar",
      summaryEn: "en",
    });

    let bal = await readBalance();
    expect(bal?.boardsOnHand.toString()).toBe("5");

    await expect(
      engine.apply({
        branchId: handle.branchId,
        productVariantId: variantId,
        movementType: "ADJUSTMENT",
        boardsDelta: "-7",
        actor,
        summaryAr: "ar",
        summaryEn: "en",
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    // Balance is unchanged after the rejected attempt — no row, no audit
    bal = await readBalance();
    expect(bal?.boardsOnHand.toString()).toBe("5");

    // Rejected attempt produced no inventory movement.
    const moves = await handle.prisma.inventoryMovement.count({
      where: { branchId: handle.branchId, productVariantId: variantId },
    });
    expect(moves).toBe(1); // only the RECEIPT
  });

  it("(b) two parallel sales racing the same balance never go negative", async () => {
    // Top up to a known starting balance of 10 boards
    const startingBalance = (await readBalance())?.boardsOnHand.toString();
    const topUp = 10 - Number(startingBalance ?? 0);
    if (topUp > 0) {
      await engine.apply({
        branchId: handle.branchId,
        productVariantId: variantId,
        movementType: "RECEIPT",
        boardsDelta: topUp.toString(),
        actor,
        summaryAr: "ar",
        summaryEn: "en",
      });
    }
    const before = await readBalance();
    expect(before?.boardsOnHand.toString()).toBe("10");

    // Fire two -7 sales concurrently. Only one should win; the other must fail.
    const settled = await Promise.allSettled(
      [1, 2].map(() =>
        engine.apply({
          branchId: handle.branchId,
          productVariantId: variantId,
          movementType: "ADJUSTMENT",
          boardsDelta: "-7",
          actor,
          summaryAr: "ar",
          summaryEn: "en",
        }),
      ),
    );

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const after = await readBalance();
    // Either 3 (if win was -7 from 10) — never negative.
    expect(after?.boardsOnHand.toString()).toBe("3");
  });

  it("(c) DB CHECK rejects a raw-SQL bypass attempt", async () => {
    // Simulate a buggy direct write that would drive the balance negative.
    // The CHECK constraint is the safety net behind the engine.
    await expect(
      handle.prisma.$executeRawUnsafe(
        `UPDATE branch_inventory_balances
           SET boards_on_hand = -1, meters_on_hand = -1
         WHERE branch_id = $1::uuid AND product_variant_id = $2::uuid`,
        handle.branchId,
        variantId,
      ),
    ).rejects.toThrow(/branch_inventory_balances_non_negative/);
  });

  it("zero-delta call is rejected (no silent ledger pollution)", async () => {
    await expect(
      engine.apply({
        branchId: handle.branchId,
        productVariantId: variantId,
        movementType: "ADJUSTMENT",
        boardsDelta: "0",
        actor,
        summaryAr: "ar",
        summaryEn: "en",
      }),
    ).rejects.toBeDefined();
  });
});
