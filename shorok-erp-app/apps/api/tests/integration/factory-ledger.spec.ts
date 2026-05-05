/**
 * T104 — Factory ledger integration tests.
 *
 * Pinned behaviour:
 *  - purchase entry derives meters + total from boards × size × price
 *  - paid_amount may be 0 (full credit) but not negative
 *  - payment-only row has total=0, variant=null, paid > 0
 *  - running_balance is correct per supplier across mixed rows
 *  - back-dated entry slots into the correct chronological position and
 *    every row's running_balance is recomputed inside the same tx
 *  - per-supplier isolation: supplier B's rows don't disturb supplier A's
 *  - audit row written same-tx with localized AR + EN summaries
 *  - RBAC: VIEWER and BRANCH_MANAGER can't write; OWNER + ACCOUNTANT can
 *  - inactive supplier rejected
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("factory-ledger", () => {
  let handle: TestApp;
  let ownerToken: string;
  let accountantToken: string;
  let bmToken: string;
  let viewerToken: string;

  let supplierAId: string;
  let supplierBId: string;
  let inactiveSupplierId: string;
  let variantId: string;
  let variant2Id: string;

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({
      where: { id: handle.ownerId },
      data: { passwordHash },
    });

    await handle.prisma.user.create({
      data: {
        name: "Acc",
        phone: "+201700020002",
        passwordHash,
        role: "ACCOUNTANT",
        status: "ACTIVE",
      },
    });
    await handle.prisma.user.create({
      data: {
        name: "BM",
        phone: "+201700010001",
        passwordHash,
        role: "BRANCH_MANAGER",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: handle.branchId } },
      },
    });
    await handle.prisma.user.create({
      data: {
        name: "View",
        phone: "+201700030003",
        passwordHash,
        role: "VIEWER",
        status: "ACTIVE",
      },
    });

    const sa = await handle.prisma.supplier.create({
      data: { nameAr: "المورد أ", nameEn: "Supplier A", active: true },
    });
    const sb = await handle.prisma.supplier.create({
      data: { nameAr: "المورد ب", nameEn: "Supplier B", active: true },
    });
    const si = await handle.prisma.supplier.create({
      data: { nameAr: "المورد ج", nameEn: "Supplier C", active: false },
    });
    supplierAId = sa.id;
    supplierBId = sb.id;
    inactiveSupplierId = si.id;

    const sku = await handle.prisma.productSku.create({
      data: {
        code: "RED-01",
        category: "NORMAL",
        colorNameAr: "أحمر",
        colorNameEn: "Red",
        active: true,
      },
    });
    const variant = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "2.5",
        defaultSalePricePerMeter: "100.00",
        defaultPurchasePricePerMeter: "70.00",
        priceOverrideTolerancePercent: "5.00",
        active: true,
      },
    });
    const variant2 = await handle.prisma.productVariant.create({
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
    variant2Id = variant2.id;

    const login = async (phone: string, password: string) => {
      const res = await request(handle.app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ phone, password });
      return res.body.accessToken as string;
    };
    ownerToken = await login(handle.ownerPhone, "Pwd@2026!");
    accountantToken = await login("+201700020002", "Pwd@2026!");
    bmToken = await login("+201700010001", "Pwd@2026!");
    viewerToken = await login("+201700030003", "Pwd@2026!");
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  const api = () => request(handle.app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it("ACCOUNTANT records purchase: meters + total derive correctly; running_balance = total - paid", async () => {
    const res = await api()
      .post("/api/v1/factory-ledger/entries")
      .set(bearer(accountantToken))
      .send({
        supplierId: supplierAId,
        orderDate: "2026-05-01",
        productVariantId: variantId,
        boardsQuantity: "10",
        purchasePricePerMeter: "70",
        paidAmount: "300",
      });
    expect(res.status).toBe(201);
    // 10 boards × 2.5 m = 25 m;  25 × 70 = 1750 total;  paid 300 → balance 1450
    // Prisma Decimal.toString() drops trailing zeros.
    expect(res.body.metersQuantity).toBe("25");
    expect(res.body.totalAmount).toBe("1750");
    expect(res.body.paidAmount).toBe("300");
    expect(res.body.runningBalance).toBe("1450");

    const audit = await handle.prisma.auditLog.findFirst({
      where: { entityType: "factory_ledger_entry", entityId: res.body.id },
    });
    expect(audit).toBeTruthy();
    expect(audit!.humanReadableSummaryAr).toContain("المورد أ");
    expect(audit!.humanReadableSummaryEn).toContain("Supplier A");
    expect(audit!.humanReadableSummaryEn).toContain("recorded a factory purchase");
  });

  it("OWNER records payment-only row: balance shrinks", async () => {
    const res = await api()
      .post("/api/v1/factory-ledger/payments")
      .set(bearer(ownerToken))
      .send({
        supplierId: supplierAId,
        orderDate: "2026-05-02",
        paidAmount: "500",
        notes: "Bank transfer",
      });
    expect(res.status).toBe(201);
    expect(res.body.totalAmount).toBe("0");
    expect(res.body.paidAmount).toBe("500");
    expect(res.body.productVariantId).toBeNull();
    // balance after: 1750 - 300 - 500 = 950
    expect(res.body.runningBalance).toBe("950");
  });

  it("Back-dated purchase recomputes every row of the supplier", async () => {
    // Insert a row dated BEFORE the existing 2026-05-01 entry. The new
    // row's total is 4 boards × 2.5 m × 100 = 1000.00, paid 0 → +1000.
    // After recompute, the chronological order is:
    //   2026-04-15 purchase 1000 paid 0  → balance 1000
    //   2026-05-01 purchase 1750 paid 300 → balance 2450
    //   2026-05-02 payment   0  paid 500  → balance 1950
    const res = await api()
      .post("/api/v1/factory-ledger/entries")
      .set(bearer(ownerToken))
      .send({
        supplierId: supplierAId,
        orderDate: "2026-04-15",
        productVariantId: variantId,
        boardsQuantity: "4",
        purchasePricePerMeter: "100",
        paidAmount: "0",
      });
    expect(res.status).toBe(201);
    expect(res.body.runningBalance).toBe("1000");

    // Verify the rest of the supplier's rows are now correct.
    const list = await api()
      .get(`/api/v1/factory-ledger?supplierId=${supplierAId}&limit=50`)
      .set(bearer(ownerToken));
    expect(list.status).toBe(200);
    const byDate = [...list.body.data].sort(
      (a, b) =>
        new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime() ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    expect(byDate.map((r: { runningBalance: string }) => r.runningBalance)).toEqual([
      "1000",
      "2450",
      "1950",
    ]);
  });

  it("Per-supplier isolation: Supplier B starts at 0 regardless of A's rows", async () => {
    const res = await api()
      .post("/api/v1/factory-ledger/entries")
      .set(bearer(accountantToken))
      .send({
        supplierId: supplierBId,
        orderDate: "2026-05-01",
        productVariantId: variant2Id,
        boardsQuantity: "2",
        purchasePricePerMeter: "80",
        paidAmount: "100",
      });
    expect(res.status).toBe(201);
    // 2 × 4.0 × 80 = 640 - 100 = 540
    expect(res.body.runningBalance).toBe("540");
  });

  it("paid > 0 required for payment-only row", async () => {
    const res = await api()
      .post("/api/v1/factory-ledger/payments")
      .set(bearer(ownerToken))
      .send({ supplierId: supplierAId, orderDate: "2026-05-03", paidAmount: "0" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("validation_failed");
  });

  it("Inactive supplier rejected", async () => {
    const res = await api()
      .post("/api/v1/factory-ledger/payments")
      .set(bearer(ownerToken))
      .send({ supplierId: inactiveSupplierId, orderDate: "2026-05-03", paidAmount: "100" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("validation_failed");
  });

  it("Boards must be positive on purchase", async () => {
    const res = await api()
      .post("/api/v1/factory-ledger/entries")
      .set(bearer(ownerToken))
      .send({
        supplierId: supplierAId,
        orderDate: "2026-05-04",
        productVariantId: variantId,
        boardsQuantity: "0",
        purchasePricePerMeter: "70",
        paidAmount: "0",
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("validation_failed");
  });

  it("VIEWER cannot write", async () => {
    const res = await api()
      .post("/api/v1/factory-ledger/payments")
      .set(bearer(viewerToken))
      .send({ supplierId: supplierAId, orderDate: "2026-05-03", paidAmount: "100" });
    expect(res.status).toBe(403);
  });

  it("BRANCH_MANAGER cannot write (factory ledger is OWNER/ACCOUNTANT only)", async () => {
    const res = await api()
      .post("/api/v1/factory-ledger/payments")
      .set(bearer(bmToken))
      .send({ supplierId: supplierAId, orderDate: "2026-05-03", paidAmount: "100" });
    expect(res.status).toBe(403);
  });

  it("List returns rows newest-first with running_balance and variant info", async () => {
    const res = await api()
      .get(`/api/v1/factory-ledger?supplierId=${supplierAId}&limit=10`)
      .set(bearer(ownerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    // Newest first
    const dates = res.body.data.map(
      (r: { orderDate: string }) => new Date(r.orderDate).getTime(),
    );
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
    // Purchase rows include variant info, payment rows do not
    const purchase = res.body.data.find(
      (r: { productVariantId: string | null }) => r.productVariantId !== null,
    );
    expect(purchase.productVariant.sku.code).toBe("RED-01");
    const payment = res.body.data.find(
      (r: { productVariantId: string | null }) => r.productVariantId === null,
    );
    expect(payment.productVariant).toBeNull();
  });
});
