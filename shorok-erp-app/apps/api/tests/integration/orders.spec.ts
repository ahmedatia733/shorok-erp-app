/**
 * T086 — Orders integration tests.
 *
 * Covers the full lifecycle:
 *   - within-tolerance happy path (DRAFT → CONFIRMED → PAID)
 *   - over-tolerance approval flow (PENDING_PRICE_APPROVAL → APPROVE → CONFIRM)
 *   - confirmation refused with `price_approval_required` when un-approved
 *   - confirmation refused with `insufficient_stock` when balance is too low
 *   - confirmation deducts inventory via the engine (not direct writes)
 *   - partial + full collection transitions
 *   - collection refused with `collection_exceeds_required`
 *   - cancellation reverses inventory and refunds collections (incl. RBAC
 *     constraint that BRANCH_MANAGER can only cancel CONFIRMED orders)
 *   - DRAFT cannot be cancelled (per state machine)
 *   - branch-scope denial for foreign-branch users
 *   - PATCH allowed only while DRAFT
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("orders lifecycle", () => {
  let handle: TestApp;
  let ownerToken: string;
  let branchManagerToken: string;
  let viewerToken: string;
  let foreignBranchManagerToken: string;
  let foreignBranchId: string;
  let normalVariantId: string; // tolerance defaults
  let strictVariantId: string; // tolerance = 1%

  beforeAll(async () => {
    handle = await buildTestApp();

    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({
      where: { id: handle.ownerId },
      data: { passwordHash },
    });
    const fb = await handle.prisma.branch.create({
      data: { nameAr: "فرع آخر", nameEn: "Other Branch", active: true },
    });
    foreignBranchId = fb.id;

    await handle.prisma.user.create({
      data: {
        name: "BM",
        phone: "+201601010101",
        passwordHash,
        role: "BRANCH_MANAGER",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: handle.branchId } },
      },
    });
    await handle.prisma.user.create({
      data: {
        name: "Viewer",
        phone: "+201602020202",
        passwordHash,
        role: "VIEWER",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: handle.branchId } },
      },
    });
    await handle.prisma.user.create({
      data: {
        name: "Foreign BM",
        phone: "+201603030303",
        passwordHash,
        role: "BRANCH_MANAGER",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: foreignBranchId } },
      },
    });

    const login = async (phone: string, password: string) => {
      const res = await request(handle.app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ phone, password });
      return res.body.accessToken as string;
    };
    ownerToken = await login(handle.ownerPhone, "Pwd@2026!");
    branchManagerToken = await login("+201601010101", "Pwd@2026!");
    viewerToken = await login("+201602020202", "Pwd@2026!");
    foreignBranchManagerToken = await login("+201603030303", "Pwd@2026!");

    const sku = await handle.prisma.productSku.create({
      data: { code: "ORD-1", colorNameAr: "أزرق", colorNameEn: "Blue", category: "NORMAL" },
    });
    const v1 = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "4",
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "80",
        // null tolerance → falls back to system default (5%)
      },
    });
    const v2 = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "5.25",
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "80",
        priceOverrideTolerancePercent: "1.00",
      },
    });
    normalVariantId = v1.id;
    strictVariantId = v2.id;
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

  /** Seed `boards` boards of `variantId` at the test's branch. */
  async function seedStock(variantId: string, boards: string) {
    const res = await api()
      .post("/api/v1/inventory/receipts")
      .set(bearer(ownerToken))
      .send({ branchId: handle.branchId, productVariantId: variantId, boardsQuantity: boards });
    expect(res.status).toBe(201);
  }

  it("creates a DRAFT order when price is within tolerance", async () => {
    await seedStock(normalVariantId, "10");

    const res = await api()
      .post("/api/v1/orders")
      .set(bearer(branchManagerToken))
      .send({
        branchId: handle.branchId,
        customerName: "Cust A",
        productVariantId: normalVariantId,
        boardsQuantity: "2",
        salePricePerMeter: "102", // 2% deviation; default tolerance 5%
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.priceOverrideStatus).toBe("WITHIN_TOLERANCE");
    // meters = 2 * 4 = 8; required = 8 * 102 = 816
    expect(res.body.metersQuantity).toBe("8");
    expect(res.body.requiredAmount).toBe("816");
  });

  it("creates PENDING_PRICE_APPROVAL when price exceeds tolerance", async () => {
    const res = await api()
      .post("/api/v1/orders")
      .set(bearer(branchManagerToken))
      .send({
        branchId: handle.branchId,
        customerName: "Cust B",
        productVariantId: strictVariantId, // 1% tolerance
        boardsQuantity: "1",
        salePricePerMeter: "108", // 8% deviation
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING_PRICE_APPROVAL");
    expect(res.body.priceOverrideStatus).toBe("PENDING_APPROVAL");
  });

  it("rejects confirm with price_approval_required when un-approved", async () => {
    const create = await api()
      .post("/api/v1/orders")
      .set(bearer(branchManagerToken))
      .send({
        branchId: handle.branchId,
        customerName: "Cust C",
        productVariantId: strictVariantId,
        boardsQuantity: "1",
        salePricePerMeter: "108",
      });
    const orderId = create.body.id;

    const confirm = await api()
      .post(`/api/v1/orders/${orderId}/confirm`)
      .set(bearer(branchManagerToken));
    expect(confirm.status).toBe(409);
    expect(confirm.body.code).toBe("price_approval_required");
    expect(confirm.body.message_ar).toBeTruthy();
    expect(confirm.body.message_en).toBeTruthy();
  });

  it("OWNER approves price; BRANCH_MANAGER then confirms successfully", async () => {
    await seedStock(strictVariantId, "5");

    const create = await api()
      .post("/api/v1/orders")
      .set(bearer(branchManagerToken))
      .send({
        branchId: handle.branchId,
        customerName: "Cust D",
        productVariantId: strictVariantId,
        boardsQuantity: "1",
        salePricePerMeter: "108",
      });
    const orderId = create.body.id;

    // BRANCH_MANAGER cannot approve
    const denied = await api()
      .post(`/api/v1/orders/${orderId}/price-approval`)
      .set(bearer(branchManagerToken));
    expect(denied.status).toBe(403);

    const approve = await api()
      .post(`/api/v1/orders/${orderId}/price-approval`)
      .set(bearer(ownerToken));
    expect(approve.status).toBe(200);
    expect(approve.body.priceOverrideStatus).toBe("APPROVED");

    const confirm = await api()
      .post(`/api/v1/orders/${orderId}/confirm`)
      .set(bearer(branchManagerToken));
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("CONFIRMED");

    // Inventory engine wrote a SALE movement
    const movements = await handle.prisma.inventoryMovement.findMany({
      where: {
        branchId: handle.branchId,
        productVariantId: strictVariantId,
        movementType: "SALE",
      },
    });
    expect(movements.length).toBeGreaterThanOrEqual(1);
    expect(movements[0]!.boardsQuantity.toString()).toBe("-1");
    expect(movements[0]!.referenceType).toBe("customer_order");
    expect(movements[0]!.referenceId).toBe(orderId);

    // CONFIRM audit row exists with both languages
    const audit = await handle.prisma.auditLog.findFirst({
      where: { entityType: "customer_order", entityId: orderId, action: "CONFIRM" },
    });
    expect(audit).toBeTruthy();
    expect(audit!.humanReadableSummaryAr).toContain("أكّد");
    expect(audit!.humanReadableSummaryEn).toContain("confirmed");
  });

  it("blocks confirmation with insufficient_stock when balance is too low", async () => {
    // Reset balance to 0 then create + confirm a 5-board order on
    // strictVariantId which currently has very little (whatever's left after
    // the prior tests). Use a fresh variant to be deterministic.
    const sku = await handle.prisma.productSku.create({
      data: { code: "INV-LOW", colorNameAr: "أحمر", colorNameEn: "Red", category: "NORMAL" },
    });
    const variant = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "4",
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "80",
      },
    });
    await seedStock(variant.id, "2");

    const create = await api()
      .post("/api/v1/orders")
      .set(bearer(ownerToken))
      .send({
        branchId: handle.branchId,
        customerName: "Cust E",
        productVariantId: variant.id,
        boardsQuantity: "5", // exceeds the 2 in stock
        salePricePerMeter: "100",
      });
    expect(create.status).toBe(201);

    const confirm = await api()
      .post(`/api/v1/orders/${create.body.id}/confirm`)
      .set(bearer(ownerToken));
    expect(confirm.status).toBe(409);
    expect(confirm.body.code).toBe("insufficient_stock");
    expect(confirm.body.message_ar).toBeTruthy();
    expect(confirm.body.message_en).toBeTruthy();

    // Order remained DRAFT — confirm rolled back
    const order = await handle.prisma.customerOrder.findUnique({
      where: { id: create.body.id },
    });
    expect(order?.status).toBe("DRAFT");
  });

  it("partial → full collection transitions", async () => {
    const sku = await handle.prisma.productSku.create({
      data: { code: "COL-T", colorNameAr: "بنفسجي", colorNameEn: "Purple", category: "NORMAL" },
    });
    const variant = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "4",
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "80",
      },
    });
    await seedStock(variant.id, "5");

    const create = await api()
      .post("/api/v1/orders")
      .set(bearer(ownerToken))
      .send({
        branchId: handle.branchId,
        customerName: "Cust F",
        productVariantId: variant.id,
        boardsQuantity: "1",
        salePricePerMeter: "100",
      });
    const orderId = create.body.id; // required = 400

    const confirmed = await api()
      .post(`/api/v1/orders/${orderId}/confirm`)
      .set(bearer(ownerToken));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("CONFIRMED");

    // Partial collection → PARTIALLY_COLLECTED
    const c1 = await api()
      .post(`/api/v1/orders/${orderId}/collections`)
      .set(bearer(ownerToken))
      .send({ amount: "150" });
    expect(c1.status).toBe(201);
    expect(c1.body.status).toBe("PARTIALLY_COLLECTED");
    expect(c1.body.collectedAmount).toBe("150");

    // Final collection → PAID
    const c2 = await api()
      .post(`/api/v1/orders/${orderId}/collections`)
      .set(bearer(ownerToken))
      .send({ amount: "250" });
    expect(c2.status).toBe(201);
    expect(c2.body.status).toBe("PAID");

    // Over-collection rejected
    const over = await api()
      .post(`/api/v1/orders/${orderId}/collections`)
      .set(bearer(ownerToken))
      .send({ amount: "1" });
    // Already PAID — collections rejected as invalid_state_transition
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("invalid_state_transition");
  });

  it("rejects collection that would exceed required", async () => {
    const sku = await handle.prisma.productSku.create({
      data: { code: "OVR-T", colorNameAr: "وردي", colorNameEn: "Pink", category: "NORMAL" },
    });
    const variant = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "4",
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "80",
      },
    });
    await seedStock(variant.id, "5");
    const create = await api()
      .post("/api/v1/orders")
      .set(bearer(ownerToken))
      .send({
        branchId: handle.branchId,
        customerName: "Cust G",
        productVariantId: variant.id,
        boardsQuantity: "1",
        salePricePerMeter: "100",
      });
    await api()
      .post(`/api/v1/orders/${create.body.id}/confirm`)
      .set(bearer(ownerToken));

    const tooMuch = await api()
      .post(`/api/v1/orders/${create.body.id}/collections`)
      .set(bearer(ownerToken))
      .send({ amount: "401" }); // required = 400
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.code).toBe("collection_exceeds_required");
  });

  it("cancellation reverses inventory and refunds collections (OWNER, post-collection)", async () => {
    const sku = await handle.prisma.productSku.create({
      data: { code: "CXL-T", colorNameAr: "أصفر", colorNameEn: "Yellow", category: "NORMAL" },
    });
    const variant = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "4",
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "80",
      },
    });
    await seedStock(variant.id, "5");

    const create = await api()
      .post("/api/v1/orders")
      .set(bearer(ownerToken))
      .send({
        branchId: handle.branchId,
        customerName: "Cust H",
        productVariantId: variant.id,
        boardsQuantity: "1",
        salePricePerMeter: "100",
      });
    const orderId = create.body.id;
    await api()
      .post(`/api/v1/orders/${orderId}/confirm`)
      .set(bearer(ownerToken));
    await api()
      .post(`/api/v1/orders/${orderId}/collections`)
      .set(bearer(ownerToken))
      .send({ amount: "250" });

    // Stock just before: 5 - 1 = 4
    const balanceBefore = await handle.prisma.branchInventoryBalance.findUnique({
      where: {
        branchId_productVariantId: {
          branchId: handle.branchId,
          productVariantId: variant.id,
        },
      },
    });
    expect(Number(balanceBefore?.boardsOnHand.toString())).toBe(4);

    // BRANCH_MANAGER can NOT cancel a PARTIALLY_COLLECTED order
    const denied = await api()
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set(bearer(branchManagerToken))
      .send({ reason: "test" });
    expect(denied.status).toBe(403);

    // OWNER can
    const cancel = await api()
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set(bearer(ownerToken))
      .send({ reason: "customer changed mind" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("CANCELLED");
    expect(Number(cancel.body.collectedAmount)).toBe(0);

    // Stock returned to 5
    const balanceAfter = await handle.prisma.branchInventoryBalance.findUnique({
      where: {
        branchId_productVariantId: {
          branchId: handle.branchId,
          productVariantId: variant.id,
        },
      },
    });
    expect(Number(balanceAfter?.boardsOnHand.toString())).toBe(5);

    // A negative-amount OrderCollection row was appended
    const collections = await handle.prisma.orderCollection.findMany({
      where: { orderId },
      orderBy: { collectedAt: "asc" },
    });
    const refundRow = collections.find((c) => c.amount.lessThan(0));
    expect(refundRow).toBeTruthy();
    expect(refundRow!.amount.toString()).toBe("-250");

    // CANCEL audit + COLLECT-refund audit both exist with localized text
    const cancelAudit = await handle.prisma.auditLog.findFirst({
      where: { entityType: "customer_order", entityId: orderId, action: "CANCEL" },
    });
    expect(cancelAudit?.humanReadableSummaryAr).toContain("ألغى");
    expect(cancelAudit?.humanReadableSummaryEn).toContain("cancelled");

    const refundAudit = await handle.prisma.auditLog.findFirst({
      where: {
        entityType: "customer_order",
        entityId: orderId,
        action: "COLLECT",
        humanReadableSummaryAr: { contains: "ردّ" },
      },
    });
    expect(refundAudit).toBeTruthy();
  });

  it("DRAFT order cannot be cancelled (per state machine)", async () => {
    const create = await api()
      .post("/api/v1/orders")
      .set(bearer(branchManagerToken))
      .send({
        branchId: handle.branchId,
        customerName: "Cust I",
        productVariantId: normalVariantId,
        boardsQuantity: "1",
        salePricePerMeter: "100",
      });
    const cancel = await api()
      .post(`/api/v1/orders/${create.body.id}/cancel`)
      .set(bearer(ownerToken))
      .send({});
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe("invalid_state_transition");
  });

  it("PENDING_PRICE_APPROVAL → CANCELLED works without inventory side-effects", async () => {
    const create = await api()
      .post("/api/v1/orders")
      .set(bearer(branchManagerToken))
      .send({
        branchId: handle.branchId,
        customerName: "Cust J",
        productVariantId: strictVariantId,
        boardsQuantity: "1",
        salePricePerMeter: "200", // way over tolerance
      });
    expect(create.body.status).toBe("PENDING_PRICE_APPROVAL");

    const cancel = await api()
      .post(`/api/v1/orders/${create.body.id}/cancel`)
      .set(bearer(ownerToken))
      .send({});
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("CANCELLED");

    // No SALE/ADJUSTMENT movement was posted for THIS order's variant
    // referencing this id
    const movements = await handle.prisma.inventoryMovement.findMany({
      where: { referenceId: create.body.id },
    });
    expect(movements).toHaveLength(0);
  });

  it("foreign-branch BRANCH_MANAGER blocked by BranchScopeGuard", async () => {
    const res = await api()
      .post("/api/v1/orders")
      .set(bearer(foreignBranchManagerToken))
      .send({
        branchId: handle.branchId,
        customerName: "X",
        productVariantId: normalVariantId,
        boardsQuantity: "1",
        salePricePerMeter: "100",
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("branch_forbidden");
  });

  it("VIEWER cannot create orders", async () => {
    const res = await api()
      .post("/api/v1/orders")
      .set(bearer(viewerToken))
      .send({
        branchId: handle.branchId,
        customerName: "X",
        productVariantId: normalVariantId,
        boardsQuantity: "1",
        salePricePerMeter: "100",
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("PATCH allowed only while DRAFT", async () => {
    await seedStock(normalVariantId, "5");
    const create = await api()
      .post("/api/v1/orders")
      .set(bearer(branchManagerToken))
      .send({
        branchId: handle.branchId,
        customerName: "Cust K",
        productVariantId: normalVariantId,
        boardsQuantity: "1",
        salePricePerMeter: "100",
      });
    const id = create.body.id;

    // PATCH while DRAFT — allowed
    const patch1 = await api()
      .patch(`/api/v1/orders/${id}`)
      .set(bearer(branchManagerToken))
      .send({ customerName: "Cust K (renamed)" });
    expect(patch1.status).toBe(200);
    expect(patch1.body.customerName).toBe("Cust K (renamed)");

    // confirm to leave DRAFT
    await api().post(`/api/v1/orders/${id}/confirm`).set(bearer(branchManagerToken));

    // PATCH after confirm — refused
    const patch2 = await api()
      .patch(`/api/v1/orders/${id}`)
      .set(bearer(branchManagerToken))
      .send({ customerName: "should fail" });
    expect(patch2.status).toBe(409);
    expect(patch2.body.code).toBe("invalid_state_transition");
  });
});
