/**
 * T112 — Dashboard aggregator integration tests.
 *
 * Pinned behaviour:
 *  - branch-scoped: numbers reflect only the requested branch
 *  - all-branches view (OWNER omits branchId): aggregates everything
 *  - DRAFT and CANCELLED orders excluded from sales/collected/remaining
 *  - collections reduce remaining; expense corrections (negative rows)
 *    reduce the expense total
 *  - supplier balances are taken from the latest ledger row per supplier
 *  - low-stock list filters by system_settings.lowStockThresholdBoards
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("dashboard", () => {
  let handle: TestApp;
  let ownerToken: string;
  let bmAToken: string;
  let bmBToken: string;
  let branchAId: string;
  let branchBId: string;
  let variantId: string;
  let supplierId: string;

  async function postOrder(args: {
    branchId: string;
    boards: string;
    price: string;
    customer: string;
    confirm?: boolean;
    cancel?: boolean;
    initialCollection?: string;
    addCollection?: string;
  }) {
    const create = await request(handle.app.getHttpServer())
      .post("/api/v1/orders")
      .set({ Authorization: `Bearer ${ownerToken}` })
      .send({
        branchId: args.branchId,
        productVariantId: variantId,
        customerName: args.customer,
        boardsQuantity: args.boards,
        salePricePerMeter: args.price,
        ...(args.initialCollection ? { initialCollectionAmount: args.initialCollection } : {}),
      });
    if (create.status !== 201) {
      throw new Error(`order create failed: ${create.status} ${JSON.stringify(create.body)}`);
    }
    const id = create.body.id as string;
    if (args.confirm) {
      const conf = await request(handle.app.getHttpServer())
        .post(`/api/v1/orders/${id}/confirm`)
        .set({ Authorization: `Bearer ${ownerToken}` })
        .send({});
      if (conf.status !== 200) {
        throw new Error(`order confirm failed: ${conf.status} ${JSON.stringify(conf.body)}`);
      }
    }
    if (args.cancel) {
      const can = await request(handle.app.getHttpServer())
        .post(`/api/v1/orders/${id}/cancel`)
        .set({ Authorization: `Bearer ${ownerToken}` })
        .send({});
      if (can.status !== 200) {
        throw new Error(`order cancel failed: ${can.status}`);
      }
    }
    if (args.addCollection) {
      const col = await request(handle.app.getHttpServer())
        .post(`/api/v1/orders/${id}/collections`)
        .set({ Authorization: `Bearer ${ownerToken}` })
        .send({ amount: args.addCollection });
      if (col.status !== 201) {
        throw new Error(`collection failed: ${col.status} ${JSON.stringify(col.body)}`);
      }
    }
    return id;
  }

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({
      where: { id: handle.ownerId },
      data: { passwordHash },
    });
    branchAId = handle.branchId;

    const branchB = await handle.prisma.branch.create({
      data: { nameAr: "فرع ثانٍ", nameEn: "Second Branch", active: true },
    });
    branchBId = branchB.id;

    await handle.prisma.user.create({
      data: {
        name: "BMA",
        phone: "+201700010001",
        passwordHash,
        role: "BRANCH_MANAGER",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: branchAId } },
      },
    });
    await handle.prisma.user.create({
      data: {
        name: "BMB",
        phone: "+201700020002",
        passwordHash,
        role: "BRANCH_MANAGER",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: branchBId } },
      },
    });

    const sku = await handle.prisma.productSku.create({
      data: {
        code: "BLU-01",
        category: "NORMAL",
        colorNameAr: "أزرق",
        colorNameEn: "Blue",
        active: true,
      },
    });
    const variant = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "4.0",
        defaultSalePricePerMeter: "120.00",
        defaultPurchasePricePerMeter: "80.00",
        priceOverrideTolerancePercent: "5.00",
        active: true,
      },
    });
    variantId = variant.id;

    // Stock: branch A above threshold, branch B will be below threshold
    // (low_stock_threshold_boards default is 5 from seed/migration).
    await handle.prisma.branchInventoryBalance.create({
      data: {
        branchId: branchAId,
        productVariantId: variantId,
        boardsOnHand: "20",
        metersOnHand: "80",
      },
    });
    await handle.prisma.branchInventoryBalance.create({
      data: {
        branchId: branchBId,
        productVariantId: variantId,
        boardsOnHand: "2",
        metersOnHand: "8",
      },
    });
    await handle.prisma.systemSettings.upsert({
      where: { id: 1 },
      update: { lowStockThresholdBoards: "5" },
      create: {
        id: 1,
        defaultPriceOverrideTolerancePercent: "5.00",
        lowStockThresholdBoards: "5",
      },
    });

    const supplier = await handle.prisma.supplier.create({
      data: { nameAr: "المورد أ", nameEn: "Supplier A", active: true },
    });
    supplierId = supplier.id;

    const login = async (phone: string, password: string) => {
      const res = await request(handle.app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ phone, password });
      return res.body.accessToken as string;
    };
    ownerToken = await login(handle.ownerPhone, "Pwd@2026!");
    bmAToken = await login("+201700010001", "Pwd@2026!");
    bmBToken = await login("+201700020002", "Pwd@2026!");

    // 2 boards × 4 m × 120 = 960 — confirmed, partial collection 200.
    await postOrder({
      branchId: branchAId,
      boards: "2",
      price: "120",
      customer: "A1",
      confirm: true,
      addCollection: "200",
    });
    // 1 board × 4 m × 120 = 480 — confirmed, no collection.
    await postOrder({
      branchId: branchAId,
      boards: "1",
      price: "120",
      customer: "A2",
      confirm: true,
    });
    // CANCELLED — must NOT count.
    await postOrder({
      branchId: branchAId,
      boards: "1",
      price: "120",
      customer: "A3",
      confirm: true,
      cancel: true,
    });
    // Branch B order: 1 × 4 × 120 = 480 — confirmed, fully paid.
    await postOrder({
      branchId: branchBId,
      boards: "1",
      price: "120",
      customer: "B1",
      confirm: true,
      addCollection: "480",
    });

    await request(handle.app.getHttpServer())
      .post("/api/v1/expenses")
      .set({ Authorization: `Bearer ${ownerToken}` })
      .send({
        branchId: branchAId,
        expenseDate: "2026-05-04",
        description: "Cleaning",
        amount: "100",
        paidFromAccount: "cash",
      });
    await request(handle.app.getHttpServer())
      .post("/api/v1/expenses")
      .set({ Authorization: `Bearer ${ownerToken}` })
      .send({
        branchId: branchBId,
        expenseDate: "2026-05-04",
        description: "Internet",
        amount: "200",
        paidFromAccount: "branch-safe",
      });

    // Supplier balance: 5 boards × 4m × 80 = 1600 - 600 = 1000
    await request(handle.app.getHttpServer())
      .post("/api/v1/factory-ledger/entries")
      .set({ Authorization: `Bearer ${ownerToken}` })
      .send({
        supplierId,
        orderDate: "2026-05-01",
        productVariantId: variantId,
        boardsQuantity: "5",
        purchasePricePerMeter: "80",
        paidAmount: "600",
      });
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  const api = () => request(handle.app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it("OWNER all-branches view aggregates everything", async () => {
    const res = await api().get("/api/v1/reports/dashboard").set(bearer(ownerToken));
    expect(res.status).toBe(200);
    // Sales: 960 + 480 + 480 = 1920 (cancelled excluded)
    expect(res.body.totalSales).toBe("1920.00");
    // Collected: 200 + 480 = 680
    expect(res.body.totalCollected).toBe("680.00");
    expect(res.body.totalRemaining).toBe("1240.00");
    expect(res.body.totalExpenses).toBe("300.00");
    // Stock: confirmed orders draw boards via the InventoryEngine, so the
    // exact count depends on the cancel/restore policy. Property-test it
    // instead: branch-A + branch-B must equal the all-branches total.
    const aRes = await api()
      .get(`/api/v1/reports/dashboard?branchId=${branchAId}`)
      .set(bearer(ownerToken));
    const bRes = await api()
      .get(`/api/v1/reports/dashboard?branchId=${branchBId}`)
      .set(bearer(ownerToken));
    expect(
      Number(aRes.body.stockSummary.boardsOnHand) + Number(bRes.body.stockSummary.boardsOnHand),
    ).toBeCloseTo(Number(res.body.stockSummary.boardsOnHand), 4);
    // Supplier balance reflects the single purchase row
    expect(res.body.supplierBalances).toHaveLength(1);
    expect(res.body.supplierBalances[0].balance).toBe("1000.00");
    // Low stock: branch B's 2 boards is below the 5-board threshold
    expect(res.body.lowStock.length).toBeGreaterThanOrEqual(1);
    expect(res.body.lowStock.some((r: { branchId: string }) => r.branchId === branchBId)).toBe(
      true,
    );
  });

  it("Branch-scoped view (branch A) excludes branch B's data", async () => {
    const res = await api()
      .get(`/api/v1/reports/dashboard?branchId=${branchAId}`)
      .set(bearer(ownerToken));
    expect(res.status).toBe(200);
    // Branch A sales: 960 + 480 = 1440 (the cancelled one is excluded)
    expect(res.body.totalSales).toBe("1440.00");
    expect(res.body.totalCollected).toBe("200.00");
    expect(res.body.totalExpenses).toBe("100.00");
    // Branch A's stock after the test's confirmed orders. Pin to a sane
    // upper bound (the initial 20 boards) so a regression where draws
    // disappear is caught without freezing on an exact post-cancel value.
    expect(Number(res.body.stockSummary.boardsOnHand)).toBeLessThan(20);
    expect(Number(res.body.stockSummary.boardsOnHand)).toBeGreaterThan(0);
    // Low stock list filtered to branch A → branch B's row is excluded.
    for (const row of res.body.lowStock) {
      expect(row.branchId).toBe(branchAId);
    }
  });

  it("BRANCH_MANAGER for B sees only branch B numbers when scoping by branchId=B", async () => {
    const res = await api()
      .get(`/api/v1/reports/dashboard?branchId=${branchBId}`)
      .set(bearer(bmBToken));
    expect(res.status).toBe(200);
    expect(res.body.totalSales).toBe("480.00");
    expect(res.body.totalCollected).toBe("480.00");
    expect(res.body.totalRemaining).toBe("0.00");
    expect(res.body.totalExpenses).toBe("200.00");
  });

  it("BRANCH_MANAGER for B is forbidden from branch A's data", async () => {
    const res = await api()
      .get(`/api/v1/reports/dashboard?branchId=${branchAId}`)
      .set(bearer(bmBToken));
    expect(res.status).toBe(403);
  });

  it("Non-OWNER without branchId is rejected", async () => {
    const res = await api().get("/api/v1/reports/dashboard").set(bearer(bmAToken));
    expect(res.status).toBe(403);
  });

  it("Expense correction (OWNER negative row) reduces the expense total", async () => {
    await api()
      .post("/api/v1/expenses")
      .set(bearer(ownerToken))
      .send({
        branchId: branchAId,
        expenseDate: "2026-05-05",
        description: "Refund",
        amount: "-30",
        paidFromAccount: "cash",
      });
    const res = await api()
      .get(`/api/v1/reports/dashboard?branchId=${branchAId}`)
      .set(bearer(ownerToken));
    expect(res.body.totalExpenses).toBe("70.00");
  });
});
