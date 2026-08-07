/**
 * Editing a product.
 *
 * The delicate part is not renaming things — it is that changing a default
 * purchase price is a statement about FUTURE purchases and nothing else. So
 * most of this suite checks what must NOT move: the weighted-average cost, the
 * stock, every historical invoice line and total, the ledger, and the prices of
 * sizes the user never asked to change.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("product master editing", () => {
  let handle: TestApp;
  let token: string;
  const api = () => request(handle.app.getHttpServer());
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
  const CAT = "/api/v1/products/catalogue";

  beforeAll(async () => {
    handle = await buildTestApp();
    await handle.prisma.user.update({
      where: { id: handle.ownerId },
      data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) },
    });
    token = (await api().post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" }))
      .body.accessToken as string;
  });
  afterAll(async () => teardownTestApp(handle));

  let n = 0;
  const code = () => `PE-${++n}-${Date.now().toString().slice(-5)}`;
  const mkSku = (c: string, price?: string) =>
    handle.prisma.productSku.create({
      data: {
        code: c, colorNameAr: "صنف", colorNameEn: "Product", category: "NORMAL",
        ...(price ? { initialPurchasePricePerMeter: price } : {}),
      },
    });
  const mkVariant = (skuId: string, size: string, purchase: string, active = true) =>
    handle.prisma.productVariant.create({
      data: {
        skuId, sizeMetersPerBoard: size, active,
        defaultPurchasePricePerMeter: purchase, defaultSalePricePerMeter: "100",
      },
    });
  const patch = (id: string, body: Record<string, unknown>) => auth(api().patch(`/api/v1/products/skus/${id}`)).send(body);
  const rowOf = async (id: string) =>
    (await auth(api().get(CAT).query({ active: "all" }))).body.products.find((p: { id: string }) => p.id === id);

  // ── price projection (§37) ───────────────────────────────────────────────

  it("reports SINGLE when every eligible size agrees", async () => {
    const sku = await mkSku(code());
    await mkVariant(sku.id, "5.25", "498.00");
    await mkVariant(sku.id, "4", "498.00");
    const r = await rowOf(sku.id);
    expect(r.purchasePriceState).toBe("SINGLE");
    expect(r.defaultPurchasePrice).toBe("498.00");
    expect(r.eligibleVariantCount).toBe(2);
  });

  it("reports MULTIPLE when sizes disagree, and picks no favourite", async () => {
    const sku = await mkSku(code());
    await mkVariant(sku.id, "5.25", "498.00");
    await mkVariant(sku.id, "4", "510.00");
    const r = await rowOf(sku.id);
    expect(r.purchasePriceState).toBe("MULTIPLE");
    expect(r.defaultPurchasePrice).toBeNull();
  });

  it("falls back to the product's own price when it has no eligible size", async () => {
    const sku = await mkSku(code(), "470.00");
    const r = await rowOf(sku.id);
    expect(r.purchasePriceState).toBe("SINGLE");
    expect(r.defaultPurchasePrice).toBe("470.00");
    expect(r.eligibleVariantCount).toBe(0);
  });

  it("reports NONE when nothing has been set anywhere", async () => {
    const sku = await mkSku(code());
    const r = await rowOf(sku.id);
    expect(r.purchasePriceState).toBe("NONE");
    expect(r.defaultPurchasePrice).toBeNull();
  });

  it("ignores inactive sizes when deciding the default", async () => {
    const sku = await mkSku(code());
    await mkVariant(sku.id, "5.25", "498.00");
    await mkVariant(sku.id, "4", "999.00", false); // inactive, not purchasable
    const r = await rowOf(sku.id);
    expect(r.purchasePriceState).toBe("SINGLE");
    expect(r.defaultPurchasePrice).toBe("498.00");
    expect(r.eligibleVariantCount).toBe(1);
  });

  // ── the P13 regression that matters most ────────────────────────────────

  it("shows the CURRENT default, not the latest historical purchase price", async () => {
    const sku = await mkSku(code());
    const v = await mkVariant(sku.id, "5.25", "520.00"); // current default
    const supplier = await handle.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "Supplier" } });
    const inv = await handle.prisma.purchaseInvoice.create({
      data: {
        invoiceNumber: `PI-T-${Date.now()}-1`,
        supplierId: supplier.id, branchId: handle.branchId, invoiceDate: new Date(),
        status: "CONFIRMED", subtotal: "6000", taxAmount: "0", grandTotal: "6000", createdBy: handle.ownerId,
      },
    });
    await handle.prisma.purchaseInvoiceLine.create({
      data: {
        invoiceId: inv.id, productVariantId: v.id, boardsQuantity: "10",
        metersQuantity: "52.5", unitPrice: "600.00", lineTotal: "6000", // history says 600
      },
    });

    const r = await rowOf(sku.id);
    expect(r.defaultPurchasePrice).toBe("520.00"); // the editable default
    expect(r.latestConfirmedPurchasePrice).toBe("600.00"); // history, for reference
    expect(r.purchasePriceState).toBe("SINGLE");
  });

  // ── editing ─────────────────────────────────────────────────────────────

  it("edits the Arabic name without touching the English one", async () => {
    const sku = await mkSku(code());
    const res = await patch(sku.id, { colorNameAr: "اسم جديد" });
    expect(res.status).toBe(200);
    expect(res.body.colorNameAr).toBe("اسم جديد");
    expect(res.body.colorNameEn).toBe("Product"); // preserved, not overwritten
  });

  it("edits the code, trimming it, and allows keeping its own code", async () => {
    const sku = await mkSku(code());
    const fresh = code();
    expect((await patch(sku.id, { code: `  ${fresh}  ` })).body.code).toBe(fresh);
    expect((await patch(sku.id, { code: fresh })).status).toBe(200); // its own code is fine
  });

  it("refuses a code already used, safely, and changes nothing", async () => {
    const taken = await mkSku(code());
    const sku = await mkSku(code(), "400.00");
    await mkVariant(sku.id, "5.25", "400.00");

    const res = await patch(sku.id, { code: taken.code, colorNameAr: "محاولة", purchasePriceUpdate: { apply: true, value: "999.00" } });
    expect(res.status).toBe(409);
    expect(res.body.details.reason).toBe("PRODUCT_CODE_ALREADY_EXISTS");
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|P2002|constraint|SELECT/i);

    // the whole edit rolled back — name, code and every price
    const after = await handle.prisma.productSku.findUniqueOrThrow({ where: { id: sku.id } });
    expect(after.code).toBe(sku.code);
    expect(after.colorNameAr).toBe("صنف");
    expect(after.initialPurchasePricePerMeter?.toString()).toBe("400");
    const v = await handle.prisma.productVariant.findFirstOrThrow({ where: { skuId: sku.id } });
    expect(v.defaultPurchasePricePerMeter.toString()).toBe("400");
    expect(await handle.prisma.auditLog.count({ where: { entityType: "product_sku", entityId: sku.id, action: "UPDATE" } })).toBe(0);
  });

  it("lets exactly one of two concurrent edits take the same new code", async () => {
    const a = await mkSku(code()), b = await mkSku(code());
    const target = code();
    const res = await Promise.allSettled([patch(a.id, { code: target }), patch(b.id, { code: target })]);
    const ok = res.filter((r) => r.status === "fulfilled" && r.value.status === 200);
    expect(ok).toHaveLength(1);
    expect(await handle.prisma.productSku.count({ where: { code: target } })).toBe(1);
  });

  it("refuses firstVariant through the edit contract", async () => {
    const sku = await mkSku(code());
    const res = await patch(sku.id, { colorNameAr: "اسم", firstVariant: { sizeMetersPerBoard: "5.25" } });
    // rejected outright, or ignored — either way no size may appear
    expect(await handle.prisma.productVariant.count({ where: { skuId: sku.id } })).toBe(0);
    expect([200, 400]).toContain(res.status);
  });

  it("returns a safe 404 and 400 for a missing product and a bad id", async () => {
    expect((await patch("00000000-0000-0000-0000-000000000000", { colorNameAr: "x" })).status).toBe(404);
    const bad = await patch("not-a-uuid", { colorNameAr: "x" });
    expect(JSON.stringify(bad.body)).not.toMatch(/prisma|SELECT|stack/i);
  });

  it("refuses an unauthorized role", async () => {
    const sku = await mkSku(code());
    const wh = await handle.prisma.user.create({
      data: { name: "مخزن", phone: "+201110001234", passwordHash: await bcrypt.hash("Pwd@2026!", 10), role: "WAREHOUSE", status: "ACTIVE" },
    });
    const t = (await api().post("/api/v1/auth/login").send({ phone: wh.phone, password: "Pwd@2026!" })).body.accessToken;
    expect((await api().patch(`/api/v1/products/skus/${sku.id}`).set("Authorization", `Bearer ${t}`).send({ colorNameAr: "x" })).status).toBe(403);
  });

  // ── price editing, and everything it must not touch ─────────────────────

  it("applies a new default to every eligible size, and to the product itself", async () => {
    const sku = await mkSku(code(), "498.00");
    const k = await mkVariant(sku.id, "5.25", "498.00");
    const s = await mkVariant(sku.id, "4", "498.00");
    const dead = await mkVariant(sku.id, "3.75", "498.00", false);

    const res = await patch(sku.id, { purchasePriceUpdate: { apply: true, value: "520.00" } });
    expect(res.status).toBe(200);
    expect(res.body.variantsRepriced).toBe(2);

    expect((await handle.prisma.productSku.findUniqueOrThrow({ where: { id: sku.id } })).initialPurchasePricePerMeter?.toString()).toBe("520");
    expect((await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: k.id } })).defaultPurchasePricePerMeter.toString()).toBe("520");
    expect((await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: s.id } })).defaultPurchasePricePerMeter.toString()).toBe("520");
    // the inactive size is not on offer, so it was left alone
    expect((await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: dead.id } })).defaultPurchasePricePerMeter.toString()).toBe("498");
    expect((await rowOf(sku.id)).defaultPurchasePrice).toBe("520.00");
  });

  it("leaves every size's price alone when only the name is edited", async () => {
    const sku = await mkSku(code());
    const k = await mkVariant(sku.id, "5.25", "498.00");
    const s = await mkVariant(sku.id, "4", "510.00"); // MULTIPLE

    const res = await patch(sku.id, { colorNameAr: "اسم مختلف" });
    expect(res.status).toBe(200);
    expect(res.body.variantsRepriced).toBe(0);
    expect((await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: k.id } })).defaultPurchasePricePerMeter.toString()).toBe("498");
    expect((await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: s.id } })).defaultPurchasePricePerMeter.toString()).toBe("510");
    expect((await rowOf(sku.id)).purchasePriceState).toBe("MULTIPLE"); // still not unified
  });

  it("unifies differing sizes only when a price is explicitly supplied", async () => {
    const sku = await mkSku(code());
    await mkVariant(sku.id, "5.25", "498.00");
    await mkVariant(sku.id, "4", "510.00");
    expect((await rowOf(sku.id)).purchasePriceState).toBe("MULTIPLE");

    const res = await patch(sku.id, { purchasePriceUpdate: { apply: true, value: "520.00" } });
    expect(res.status).toBe(200);
    const r = await rowOf(sku.id);
    expect(r.purchasePriceState).toBe("SINGLE");
    expect(r.defaultPurchasePrice).toBe("520.00");
  });

  it.each(["0", "-5", "abc", "", "1.234"])("rejects the invalid price %p", async (value) => {
    const sku = await mkSku(code());
    const v = await mkVariant(sku.id, "5.25", "498.00");
    const res = await patch(sku.id, { purchasePriceUpdate: { apply: true, value } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: v.id } })).defaultPurchasePricePerMeter.toString()).toBe("498");
  });

  it("changes NOTHING about stock, cost, history or the ledger", async () => {
    const sku = await mkSku(code(), "498.00");
    const v = await mkVariant(sku.id, "5.25", "498.00");
    await handle.prisma.productVariant.update({ where: { id: v.id }, data: { avgCostPerMeter: "477.1234", avgCost: "12.5" } });
    await handle.prisma.branchInventoryBalance.create({
      data: { branchId: handle.branchId, productVariantId: v.id, boardsOnHand: "20", metersOnHand: "105" },
    });
    const supplier = await handle.prisma.supplier.create({ data: { nameAr: "مورد ٢", nameEn: "Supplier 2" } });
    const inv = await handle.prisma.purchaseInvoice.create({
      data: {
        invoiceNumber: `PI-T-${Date.now()}-2`,
        supplierId: supplier.id, branchId: handle.branchId, invoiceDate: new Date(), status: "CONFIRMED",
        subtotal: "4980", taxAmount: "249", grandTotal: "5229", createdBy: handle.ownerId,
      },
    });
    const line = await handle.prisma.purchaseInvoiceLine.create({
      data: {
        invoiceId: inv.id, productVariantId: v.id, boardsQuantity: "10", metersQuantity: "52.5",
        unitPrice: "498.00", lineTotal: "4980", unitCostAtPosting: "498.00",
      },
    });

    const before = {
      wac: (await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: v.id } })).avgCostPerMeter.toString(),
      avgCost: (await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: v.id } })).avgCost.toString(),
      salePrice: (await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: v.id } })).defaultSalePricePerMeter.toString(),
      balances: await handle.prisma.branchInventoryBalance.count(),
      boards: (await handle.prisma.branchInventoryBalance.aggregate({ _sum: { boardsOnHand: true } }))._sum.boardsOnHand?.toString(),
      meters: (await handle.prisma.branchInventoryBalance.aggregate({ _sum: { metersOnHand: true } }))._sum.metersOnHand?.toString(),
      movements: await handle.prisma.inventoryMovement.count(),
      journals: await handle.prisma.journalEntry.count(),
      journalLines: await handle.prisma.journalLine.count(),
      transfers: await handle.prisma.inventoryTransfer.count(),
      sales: await handle.prisma.salesInvoice.count(),
      lineUnitPrice: line.unitPrice.toString(),
      lineCostAtPosting: line.unitCostAtPosting?.toString(),
      invSubtotal: inv.subtotal.toString(),
      invTax: inv.taxAmount.toString(),
      invGrand: inv.grandTotal.toString(),
    };

    const res = await patch(sku.id, { code: code(), colorNameAr: "بعد التعديل", purchasePriceUpdate: { apply: true, value: "777.00" } });
    expect(res.status).toBe(200);

    const vAfter = await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: v.id } });
    expect(vAfter.avgCostPerMeter.toString()).toBe(before.wac);      // WAC untouched
    expect(vAfter.avgCost.toString()).toBe(before.avgCost);
    expect(vAfter.defaultSalePricePerMeter.toString()).toBe(before.salePrice);
    expect(vAfter.defaultPurchasePricePerMeter.toString()).toBe("777"); // only this moved

    expect(await handle.prisma.branchInventoryBalance.count()).toBe(before.balances);
    expect((await handle.prisma.branchInventoryBalance.aggregate({ _sum: { boardsOnHand: true } }))._sum.boardsOnHand?.toString()).toBe(before.boards);
    expect((await handle.prisma.branchInventoryBalance.aggregate({ _sum: { metersOnHand: true } }))._sum.metersOnHand?.toString()).toBe(before.meters);
    expect(await handle.prisma.inventoryMovement.count()).toBe(before.movements);
    expect(await handle.prisma.journalEntry.count()).toBe(before.journals);
    expect(await handle.prisma.journalLine.count()).toBe(before.journalLines);
    expect(await handle.prisma.inventoryTransfer.count()).toBe(before.transfers);
    expect(await handle.prisma.salesInvoice.count()).toBe(before.sales);

    // history keeps the price that was actually agreed
    const lineAfter = await handle.prisma.purchaseInvoiceLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(lineAfter.unitPrice.toString()).toBe(before.lineUnitPrice);
    expect(lineAfter.unitCostAtPosting?.toString()).toBe(before.lineCostAtPosting);
    const invAfter = await handle.prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(invAfter.subtotal.toString()).toBe(before.invSubtotal);
    expect(invAfter.taxAmount.toString()).toBe(before.invTax);
    expect(invAfter.grandTotal.toString()).toBe(before.invGrand);
  });

  it("audits a successful edit once, and says the price was a default", async () => {
    const sku = await mkSku(code());
    await mkVariant(sku.id, "5.25", "498.00");
    await patch(sku.id, { purchasePriceUpdate: { apply: true, value: "530.00" } });
    const logs = await handle.prisma.auditLog.findMany({ where: { entityType: "product_sku", entityId: sku.id, action: "UPDATE" } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.actorId).toBe(handle.ownerId);
    expect(logs[0]!.humanReadableSummaryAr).toContain("سعر الشراء الافتراضي");
    expect(logs[0]!.humanReadableSummaryAr).toContain("لم يتغيّر المخزون");
  });

  it("reading the catalogue writes nothing", async () => {
    const before = {
      skus: await handle.prisma.productSku.count(),
      variants: await handle.prisma.productVariant.count(),
      audits: await handle.prisma.auditLog.count(),
    };
    for (let i = 0; i < 3; i++) expect((await auth(api().get(CAT))).status).toBe(200);
    expect(await handle.prisma.productSku.count()).toBe(before.skus);
    expect(await handle.prisma.productVariant.count()).toBe(before.variants);
    expect(await handle.prisma.auditLog.count()).toBe(before.audits);
  });
});
