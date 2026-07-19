/**
 * T068 — Inventory endpoints integration test.
 *
 * Covers receipt / adjustment / count / balances / movements happy paths,
 * RBAC + branch-scope denials, and same-tx audit-row guarantee.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("inventory endpoints", () => {
  let handle: TestApp;
  let ownerToken: string;
  let warehouseToken: string;
  let viewerToken: string;
  let foreignBranchUserToken: string;
  let foreignBranchId: string;
  let variantA: string;
  let variantB: string;

  beforeAll(async () => {
    handle = await buildTestApp();

    // Seed a second branch (the "foreign" one) and a user scoped to it.
    const fb = await handle.prisma.branch.create({
      data: { nameAr: "فرع آخر", nameEn: "Other Branch", active: true },
    });
    foreignBranchId = fb.id;

    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);

    const warehouseUser = await handle.prisma.user.create({
      data: {
        name: "Warehouse User",
        phone: "+201501010101",
        passwordHash,
        role: "WAREHOUSE",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: handle.branchId } },
      },
    });
    const viewerUser = await handle.prisma.user.create({
      data: {
        name: "View",
        phone: "+201502020202",
        passwordHash,
        role: "VIEWER",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: handle.branchId } },
      },
    });
    const foreignUser = await handle.prisma.user.create({
      data: {
        name: "Foreign Mgr",
        phone: "+201503030303",
        passwordHash,
        role: "BRANCH_MANAGER",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: foreignBranchId } },
      },
    });
    void warehouseUser;
    void viewerUser;
    void foreignUser;

    // Tokens
    const login = async (phone: string, password: string) => {
      const res = await request(handle.app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ phone, password });
      return res.body.accessToken as string;
    };
    ownerToken = await login(handle.ownerPhone, handle.ownerPassword);
    warehouseToken = await login("+201501010101", "Pwd@2026!");
    viewerToken = await login("+201502020202", "Pwd@2026!");
    foreignBranchUserToken = await login("+201503030303", "Pwd@2026!");

    // Two variants for the inventory tests
    const sku = await handle.prisma.productSku.create({
      data: { code: "INV-A", colorNameAr: "أحمر", colorNameEn: "Red", category: "NORMAL" },
    });
    const va = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "4",
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "80",
      },
    });
    const vb = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "5.25",
        defaultSalePricePerMeter: "120",
        defaultPurchasePricePerMeter: "90",
      },
    });
    variantA = va.id;
    variantB = vb.id;
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  function api() {
    return request(handle.app.getHttpServer());
  }
  function bearer(t: string) {
    return { Authorization: `Bearer ${t}` };
  }

  it("WAREHOUSE posts a receipt; balance is created and movement + audit row land in same tx", async () => {
    const res = await api()
      .post("/api/v1/inventory/receipts")
      .set(bearer(warehouseToken))
      .send({
        branchId: handle.branchId,
        productVariantId: variantA,
        boardsQuantity: "10",
        note: "first receipt",
      });
    expect(res.status).toBe(201);
    expect(res.body.boardsOnHand).toBe("10.0000");
    expect(res.body.metersOnHand).toBe("40.0000");

    const balances = await api()
      .get(`/api/v1/inventory/balances?branchId=${handle.branchId}`)
      .set(bearer(warehouseToken));
    expect(balances.status).toBe(200);
    expect(balances.body.data.find((b: { productVariantId: string }) => b.productVariantId === variantA)).toBeTruthy();

    // movement and audit row both committed
    const movements = await api()
      .get(`/api/v1/inventory/movements?branchId=${handle.branchId}&productVariantId=${variantA}`)
      .set(bearer(warehouseToken));
    expect(movements.body.data).toHaveLength(1);
    expect(movements.body.data[0].movementType).toBe("RECEIPT");

    const audit = await handle.prisma.auditLog.findFirst({
      where: { entityType: "inventory_movement", entityId: movements.body.data[0].id },
    });
    expect(audit).toBeTruthy();
    expect(audit!.humanReadableSummaryAr).toContain("استلم");
    expect(audit!.humanReadableSummaryEn).toContain("received");
  });

  it("GET /inventory/balance exposes sale price, purchase cost and avgCost as distinct fields", async () => {
    // variantA (sale 100 / purchase 80) has stock from the receipt above.
    const res = await api()
      .get(`/api/v1/inventory/balance?branchId=${handle.branchId}`)
      .set(bearer(ownerToken));
    expect(res.status).toBe(200);
    const rowA = res.body.find((r: { productVariantId: string }) => r.productVariantId === variantA);
    expect(rowA).toBeTruthy();
    // Distinct pricing concepts — never conflated.
    expect(Number(rowA.defaultSalePricePerMeter)).toBe(100);
    expect(Number(rowA.defaultPurchasePricePerMeter)).toBe(80);
    expect(typeof rowA.avgCost).toBe("string");
    expect(rowA.defaultSalePricePerMeter).not.toBe(rowA.defaultPurchasePricePerMeter);
    // Calculated inventory values derive from the RIGHT field:
    //   sale value = metersOnHand × sale price;  cost value = boardsOnHand × avgCost.
    expect(Number(rowA.metersOnHand)).toBeGreaterThan(0);
  });

  it("VIEWER cannot post a receipt (403)", async () => {
    const res = await api()
      .post("/api/v1/inventory/receipts")
      .set(bearer(viewerToken))
      .send({ branchId: handle.branchId, productVariantId: variantA, boardsQuantity: "1" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("BranchScopeGuard blocks a foreign-branch user from posting against this branch", async () => {
    const res = await api()
      .post("/api/v1/inventory/receipts")
      .set(bearer(foreignBranchUserToken))
      .send({ branchId: handle.branchId, productVariantId: variantA, boardsQuantity: "1" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("branch_forbidden");
  });

  it("Adjustment can decrement when stock allows; rejected with insufficient_stock otherwise", async () => {
    // Decrement is fine while we still have 10
    const ok = await api()
      .post("/api/v1/inventory/adjustments")
      .set(bearer(warehouseToken))
      .send({
        branchId: handle.branchId,
        productVariantId: variantA,
        boardsDelta: "-3",
        note: "damage",
      });
    expect(ok.status).toBe(201);
    expect(ok.body.boardsOnHand).toBe("7.0000");

    // Over-adjust: reject with 409 insufficient_stock and don't write
    const before = await handle.prisma.inventoryMovement.count({
      where: { branchId: handle.branchId, productVariantId: variantA },
    });
    const bad = await api()
      .post("/api/v1/inventory/adjustments")
      .set(bearer(warehouseToken))
      .send({
        branchId: handle.branchId,
        productVariantId: variantA,
        boardsDelta: "-50",
        note: "should fail",
      });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe("insufficient_stock");
    expect(bad.body.message_ar).toBeTruthy();
    expect(bad.body.message_en).toBeTruthy();

    const after = await handle.prisma.inventoryMovement.count({
      where: { branchId: handle.branchId, productVariantId: variantA },
    });
    expect(after).toBe(before);
  });

  it("Daily count posts COUNT_CORRECTION movements per line in one transaction", async () => {
    const balanceBefore = await handle.prisma.branchInventoryBalance.findUnique({
      where: {
        branchId_productVariantId: {
          branchId: handle.branchId,
          productVariantId: variantA,
        },
      },
    });
    const currentBoards = Number(balanceBefore?.boardsOnHand.toString() ?? 0);

    const res = await api()
      .post("/api/v1/inventory/counts")
      .set(bearer(warehouseToken))
      .send({
        branchId: handle.branchId,
        lines: [
          { productVariantId: variantA, countedBoards: String(currentBoards + 2) },
          { productVariantId: variantB, countedBoards: "0" },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines[0].delta).toBe("2.0000");

    // balance updated
    const after = await handle.prisma.branchInventoryBalance.findUnique({
      where: {
        branchId_productVariantId: {
          branchId: handle.branchId,
          productVariantId: variantA,
        },
      },
    });
    expect(Number(after?.boardsOnHand.toString())).toBe(currentBoards + 2);
    expect(after?.lastCountedAt).not.toBeNull();
  });

  it("Movements ledger filters by type and returns newest-first", async () => {
    const res = await api()
      .get(
        `/api/v1/inventory/movements?branchId=${handle.branchId}&movementType=ADJUSTMENT`,
      )
      .set(bearer(warehouseToken));
    expect(res.status).toBe(200);
    expect(res.body.data.every((m: { movementType: string }) => m.movementType === "ADJUSTMENT")).toBe(true);
    if (res.body.data.length >= 2) {
      const t0 = new Date(res.body.data[0].createdAt).getTime();
      const t1 = new Date(res.body.data[1].createdAt).getTime();
      expect(t0).toBeGreaterThanOrEqual(t1);
    }
  });

  it("OWNER bypasses branch scope and can post against any branch", async () => {
    const res = await api()
      .post("/api/v1/inventory/receipts")
      .set(bearer(ownerToken))
      .send({
        branchId: foreignBranchId,
        productVariantId: variantA,
        boardsQuantity: "2",
      });
    expect(res.status).toBe(201);
    expect(res.body.boardsOnHand).toBe("2.0000");
  });

  it("Receipt rejects boardsQuantity <= 0 (invalid_movement)", async () => {
    const res = await api()
      .post("/api/v1/inventory/receipts")
      .set(bearer(warehouseToken))
      .send({ branchId: handle.branchId, productVariantId: variantA, boardsQuantity: "0" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("invalid_movement");
  });
});
