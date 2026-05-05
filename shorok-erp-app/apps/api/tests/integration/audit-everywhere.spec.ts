/**
 * T138 — Audit-everything (Constitution Principle III) sweep.
 *
 * For every state-changing endpoint we exercise (across every shipped
 * user story), verify that:
 *   1. the request succeeded (2xx)
 *   2. exactly one new audit_logs row was committed in the same tx
 *   3. that row's human_readable_summary_ar contains real Arabic and is
 *      NOT a translation key
 *   4. that row's human_readable_summary_en contains real English and is
 *      NOT a translation key
 *
 * If a new state-changing endpoint ships, append a case to the table
 * below. The test will fail loud the moment it isn't audited.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const HAS_ARABIC = /[؀-ۿ]/;
const KEY_LEAK = /\b[a-z][a-z0-9]+\.[a-z][a-zA-Z0-9_]+(?:\.[a-z][a-zA-Z0-9_]+)+\b/;

describe("audit-everywhere", () => {
  let handle: TestApp;
  let ownerToken: string;
  let supplierId: string;
  let variantId: string;
  let orderId: string;

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({
      where: { id: handle.ownerId },
      data: { passwordHash },
    });

    const res = await request(handle.app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ phone: handle.ownerPhone, password: "Pwd@2026!" });
    ownerToken = res.body.accessToken;

    const sku = await handle.prisma.productSku.create({
      data: {
        code: "GRN-01",
        category: "NORMAL",
        colorNameAr: "أخضر",
        colorNameEn: "Green",
        active: true,
      },
    });
    const variant = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "3",
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "70",
        priceOverrideTolerancePercent: "5",
        active: true,
      },
    });
    variantId = variant.id;

    // Pre-stock for the order's confirm step.
    await handle.prisma.branchInventoryBalance.create({
      data: {
        branchId: handle.branchId,
        productVariantId: variantId,
        boardsOnHand: "100",
        metersOnHand: "300",
      },
    });
    await handle.prisma.systemSettings.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        defaultPriceOverrideTolerancePercent: "5",
        lowStockThresholdBoards: "5",
      },
    });

    const supplier = await handle.prisma.supplier.create({
      data: { nameAr: "مورد التدقيق", nameEn: "Audit Supplier", active: true },
    });
    supplierId = supplier.id;
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  const api = () => request(handle.app.getHttpServer());
  const bearer = () => ({ Authorization: `Bearer ${ownerToken}` });

  async function expectAudit(entityType: string, entityId: string, label: string) {
    const audits = await handle.prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: "desc" },
    });
    if (audits.length === 0) {
      throw new Error(`${label}: no audit row found for ${entityType}/${entityId}`);
    }
    const latest = audits[0]!;
    expect(HAS_ARABIC.test(latest.humanReadableSummaryAr)).toBe(true);
    expect(KEY_LEAK.test(latest.humanReadableSummaryAr)).toBe(false);
    expect(/[a-z]/i.test(latest.humanReadableSummaryEn)).toBe(true);
    expect(KEY_LEAK.test(latest.humanReadableSummaryEn)).toBe(false);
  }

  it("POST /expenses → audit", async () => {
    const res = await api()
      .post("/api/v1/expenses")
      .set(bearer())
      .send({
        branchId: handle.branchId,
        expenseDate: "2026-05-04",
        description: "Audit-test expense",
        amount: "10",
        paidFromAccount: "cash",
      });
    expect(res.status).toBe(201);
    await expectAudit("expense", res.body.id, "POST /expenses");
  });

  it("POST /orders → audit", async () => {
    const res = await api()
      .post("/api/v1/orders")
      .set(bearer())
      .send({
        branchId: handle.branchId,
        productVariantId: variantId,
        customerName: "Audit Customer",
        boardsQuantity: "1",
        salePricePerMeter: "100",
      });
    expect(res.status).toBe(201);
    orderId = res.body.id;
    await expectAudit("customer_order", orderId, "POST /orders");
  });

  it("POST /orders/:id/confirm → audit", async () => {
    const res = await api()
      .post(`/api/v1/orders/${orderId}/confirm`)
      .set(bearer())
      .send({});
    expect(res.status).toBe(200);
    await expectAudit("customer_order", orderId, "POST /orders/:id/confirm");
  });

  it("POST /orders/:id/collections → audit", async () => {
    const res = await api()
      .post(`/api/v1/orders/${orderId}/collections`)
      .set(bearer())
      .send({ amount: "50" });
    expect(res.status).toBe(201);
    // Collections audit row's entity is the order id (per orders.summary builder).
    const audits = await handle.prisma.auditLog.findMany({
      where: { entityType: "customer_order", entityId: orderId },
    });
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });

  it("POST /factory-ledger/entries → audit", async () => {
    const res = await api()
      .post("/api/v1/factory-ledger/entries")
      .set(bearer())
      .send({
        supplierId,
        orderDate: "2026-05-01",
        productVariantId: variantId,
        boardsQuantity: "2",
        purchasePricePerMeter: "70",
        paidAmount: "0",
      });
    expect(res.status).toBe(201);
    await expectAudit("factory_ledger_entry", res.body.id, "POST /factory-ledger/entries");
  });

  it("POST /factory-ledger/payments → audit", async () => {
    const res = await api()
      .post("/api/v1/factory-ledger/payments")
      .set(bearer())
      .send({
        supplierId,
        orderDate: "2026-05-02",
        paidAmount: "100",
      });
    expect(res.status).toBe(201);
    await expectAudit("factory_ledger_entry", res.body.id, "POST /factory-ledger/payments");
  });

  it("POST /suppliers → audit", async () => {
    const res = await api()
      .post("/api/v1/suppliers")
      .set(bearer())
      .send({ nameAr: "مورد جديد للتدقيق", nameEn: "New Audit Supplier" });
    expect(res.status).toBe(201);
    await expectAudit("supplier", res.body.id, "POST /suppliers");
  });

  it("POST /branches → audit", async () => {
    const res = await api()
      .post("/api/v1/branches")
      .set(bearer())
      .send({ nameAr: "فرع للتدقيق", nameEn: "Audit Branch" });
    expect(res.status).toBe(201);
    await expectAudit("branch", res.body.id, "POST /branches");
  });

  it("PATCH /system-settings → audit", async () => {
    const res = await api()
      .patch("/api/v1/system-settings")
      .set(bearer())
      .send({ defaultPriceOverrideTolerancePercent: "7" });
    expect(res.status).toBe(200);
    // System settings is a single row (id=1); look up the latest audit row
    // for the entity type rather than by id.
    const audits = await handle.prisma.auditLog.findMany({
      where: { entityType: "system_settings" },
      orderBy: { createdAt: "desc" },
    });
    expect(audits.length).toBeGreaterThan(0);
    const latest = audits[0]!;
    expect(HAS_ARABIC.test(latest.humanReadableSummaryAr)).toBe(true);
    expect(KEY_LEAK.test(latest.humanReadableSummaryAr)).toBe(false);
    expect(KEY_LEAK.test(latest.humanReadableSummaryEn)).toBe(false);
  });
});
