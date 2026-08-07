/**
 * Product master — the base-product catalogue and its creation.
 *
 * Two promises are worth stating as assertions. First, this screen is about the
 * BASE product: a product with five sizes is one row, and creating a product
 * creates a product and nothing else — no size, no stock, no movement, no
 * posting. Second, the price it shows is a real one: the latest confirmed
 * purchase if there is any, the figure typed at creation if not, and an honest
 * blank when there is neither.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("product master", () => {
  let handle: TestApp;
  let token: string;
  const api = () => request(handle.app.getHttpServer());
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
  const CATALOGUE = "/api/v1/products/catalogue";
  const SKUS = "/api/v1/products/skus";

  beforeAll(async () => {
    handle = await buildTestApp();
    await handle.prisma.user.update({
      where: { id: handle.ownerId },
      data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) },
    });
    token = (
      await api().post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })
    ).body.accessToken as string;
  });

  afterAll(async () => teardownTestApp(handle));

  let seq = 0;
  const uniqueCode = () => `PM-${++seq}-${Date.now().toString().slice(-5)}`;
  const create = (body: Record<string, unknown>) => auth(api().post(SKUS)).send(body);
  const catalogue = (q: Record<string, string> = {}) => auth(api().get(CATALOGUE).query(q));
  const row = (body: { products: Array<{ id: string }> }, id: string) =>
    body.products.filter((p) => p.id === id);

  // ── creation ─────────────────────────────────────────────────────────────

  it("creates a base product from code, name and price alone", async () => {
    const code = uniqueCode();
    const res = await create({ code, colorNameAr: "أسود لامع", initialPurchasePricePerMeter: "498.50" });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe(code);
    expect(res.body.colorNameAr).toBe("أسود لامع");
    // no English name was supplied, so the Arabic one is carried over rather
    // than left blank or invented
    expect(res.body.colorNameEn).toBe("أسود لامع");
    expect(res.body.active).toBe(true);
  });

  it("trims the code so a stray space cannot create a second product", async () => {
    const code = uniqueCode();
    const first = await create({ code: `  ${code}  `, colorNameAr: "رمادي" });
    expect(first.status).toBe(201);
    expect(first.body.code).toBe(code);
    const second = await create({ code, colorNameAr: "رمادي مرة أخرى" });
    expect(second.status).toBe(409);
  });

  it.each([
    ["", "أسود", "blank code"],
    ["   ", "أسود", "whitespace-only code"],
  ])("rejects %p (%s)", async (code, name) => {
    expect((await create({ code, colorNameAr: name })).status).toBe(400);
  });

  it("rejects a blank product name", async () => {
    expect((await create({ code: uniqueCode(), colorNameAr: "   " })).status).toBe(400);
  });

  it.each(["0", "-1", "abc", ""])("rejects the invalid price %p", async (price) => {
    const res = await create({ code: uniqueCode(), colorNameAr: "لون", initialPurchasePricePerMeter: price });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("keeps an exact decimal price rather than a float", async () => {
    const code = uniqueCode();
    await create({ code, colorNameAr: "دقة", initialPurchasePricePerMeter: "1234.56" });
    const r = row((await catalogue()).body, (await catalogue()).body.products.find((p: { code: string }) => p.code === code)!.id)[0]!;
    expect(r.purchasePrice).toBe("1234.56");
  });

  it("reports a duplicate code as a safe Arabic conflict, never a 500", async () => {
    const code = uniqueCode();
    expect((await create({ code, colorNameAr: "أول" })).status).toBe(201);
    const dup = await create({ code, colorNameAr: "ثانٍ" });
    expect(dup.status).toBe(409);
    expect(dup.body.details.reason).toBe("PRODUCT_CODE_ALREADY_EXISTS");
    expect(dup.body.details.messageAr).toBe("كود الصنف مستخدم بالفعل.");
    expect(JSON.stringify(dup.body)).not.toMatch(/prisma|P2002|constraint|SELECT|stack/i);
    expect(await handle.prisma.productSku.count({ where: { code } })).toBe(1);
  });

  it("lets exactly one of two simultaneous creates win the same code", async () => {
    const code = uniqueCode();
    const results = await Promise.allSettled([
      create({ code, colorNameAr: "سباق أ" }),
      create({ code, colorNameAr: "سباق ب" }),
    ]);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0));
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);
    expect(await handle.prisma.productSku.count({ where: { code } })).toBe(1);
  });

  it("creates a product and NOTHING else", async () => {
    const before = {
      variants: await handle.prisma.productVariant.count(),
      balances: await handle.prisma.branchInventoryBalance.count(),
      movements: await handle.prisma.inventoryMovement.count(),
      journals: await handle.prisma.journalEntry.count(),
      journalLines: await handle.prisma.journalLine.count(),
      purchases: await handle.prisma.purchaseInvoice.count(),
      sales: await handle.prisma.salesInvoice.count(),
      transfers: await handle.prisma.inventoryTransfer.count(),
      invSeq: (
        await handle.prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM sales_invoices_invoice_number_seq`
      )[0]?.last_value.toString(),
    };

    expect((await create({ code: uniqueCode(), colorNameAr: "لا شيء آخر", initialPurchasePricePerMeter: "300" })).status).toBe(201);

    expect(await handle.prisma.productVariant.count()).toBe(before.variants);
    expect(await handle.prisma.branchInventoryBalance.count()).toBe(before.balances);
    expect(await handle.prisma.inventoryMovement.count()).toBe(before.movements);
    expect(await handle.prisma.journalEntry.count()).toBe(before.journals);
    expect(await handle.prisma.journalLine.count()).toBe(before.journalLines);
    expect(await handle.prisma.purchaseInvoice.count()).toBe(before.purchases);
    expect(await handle.prisma.salesInvoice.count()).toBe(before.sales);
    expect(await handle.prisma.inventoryTransfer.count()).toBe(before.transfers);
    expect(
      (await handle.prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM sales_invoices_invoice_number_seq`)[0]?.last_value.toString(),
    ).toBe(before.invSeq);
  });

  it("audits the creation in Arabic with the acting user", async () => {
    const code = uniqueCode();
    const res = await create({ code, colorNameAr: "مدقق" });
    const log = await handle.prisma.auditLog.findFirst({
      where: { entityType: "product_sku", entityId: res.body.id },
    });
    expect(log?.action).toBe("CREATE");
    expect(log?.actorId).toBe(handle.ownerId);
    expect(log?.humanReadableSummaryAr).toContain(code);
  });

  // ── catalogue shape ──────────────────────────────────────────────────────

  it("returns ONE row per base product, never one per size", async () => {
    const sku = await handle.prisma.productSku.create({
      data: { code: uniqueCode(), colorNameAr: "متعدد المقاسات", colorNameEn: "Multi", category: "NORMAL" },
    });
    for (const size of ["5.25", "4", "3.75"]) {
      await handle.prisma.productVariant.create({
        data: {
          skuId: sku.id,
          sizeMetersPerBoard: size,
          defaultSalePricePerMeter: "100",
          defaultPurchasePricePerMeter: "80",
        },
      });
    }
    const res = await catalogue();
    expect(res.status).toBe(200);
    const hits = row(res.body, sku.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.variantCount).toBe(3);
    // and no size information leaks into the row
    expect(JSON.stringify(hits[0])).not.toMatch(/5\.25|sizeMeters|ك|م\/خ/);
  });

  it("orders deterministically by code and never repeats a product", async () => {
    const first = (await catalogue()).body.products.map((p: { code: string }) => p.code);
    const second = (await catalogue()).body.products.map((p: { code: string }) => p.code);
    expect(second).toEqual(first);
    expect([...first].sort()).toEqual(first);
    const ids = (await catalogue()).body.products.map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("searches by code and by Arabic name, but not beyond the catalogue", async () => {
    const code = uniqueCode();
    const sku = await handle.prisma.productSku.create({
      data: { code, colorNameAr: "أزرق بحري مميز", colorNameEn: "Navy", category: "NORMAL" },
    });
    expect(row((await catalogue({ q: code })).body, sku.id)).toHaveLength(1);
    expect(row((await catalogue({ q: "أزرق بحري" })).body, sku.id)).toHaveLength(1);
    expect((await catalogue({ q: "لا-يوجد-هذا-النص-إطلاقا" })).body.products).toHaveLength(0);
  });

  // ── price semantics ──────────────────────────────────────────────────────

  it("shows the typed starting price before any purchase exists", async () => {
    const code = uniqueCode();
    const res = await create({ code, colorNameAr: "مبدئي", initialPurchasePricePerMeter: "455.25" });
    const r = row((await catalogue()).body, res.body.id)[0]!;
    expect(r.purchasePrice).toBe("455.25");
    expect(r.purchasePriceSource).toBe("INITIAL_DEFAULT");
  });

  it("shows nothing at all when there is neither a purchase nor a starting price", async () => {
    const res = await create({ code: uniqueCode(), colorNameAr: "بدون سعر" });
    const r = row((await catalogue()).body, res.body.id)[0]!;
    expect(r.purchasePrice).toBeNull();
    expect(r.purchasePriceSource).toBe("NONE");
  });

  // ── authorization ────────────────────────────────────────────────────────

  it("rejects an unauthenticated caller on both endpoints", async () => {
    expect((await api().get(CATALOGUE)).status).toBe(401);
    expect((await api().post(SKUS).send({ code: "X", colorNameAr: "ص" })).status).toBe(401);
  });

  it("keeps product creation restricted to the roles that already had it", async () => {
    const wh = await handle.prisma.user.create({
      data: {
        name: "أمين مخزن",
        phone: "+201110000999",
        passwordHash: await bcrypt.hash("Pwd@2026!", 10),
        role: "WAREHOUSE",
        status: "ACTIVE",
      },
    });
    const t = (await api().post("/api/v1/auth/login").send({ phone: wh.phone, password: "Pwd@2026!" }))
      .body.accessToken as string;
    const res = await api().post(SKUS).set("Authorization", `Bearer ${t}`).send({ code: uniqueCode(), colorNameAr: "ممنوع" });
    expect(res.status).toBe(403);
  });

  // ── existing APIs still work ─────────────────────────────────────────────

  it("leaves the existing products endpoints compatible", async () => {
    const skus = await auth(api().get(SKUS));
    expect(skus.status).toBe(200);
    expect(Array.isArray(skus.body)).toBe(true);
    expect(skus.body[0]).toHaveProperty("code");
    expect((await auth(api().get("/api/v1/products/variants"))).status).toBe(200);
  });
});

/**
 * The size step exists only for the purchase-invoice route, where a line has
 * nothing to post against until an exact variant exists. It is explicit: no
 * size is ever assumed, and the product and its first size are created together
 * or not at all.
 */
describe("first variant (purchase-invoice quick add)", () => {
  let handle2: TestApp;
  let token2: string;
  const api2 = () => request(handle2.app.getHttpServer());
  const create2 = (body: Record<string, unknown>) =>
    api2().post("/api/v1/products/skus").set("Authorization", `Bearer ${token2}`).send(body);
  let n = 0;
  const code2 = () => `FV-${++n}-${Date.now().toString().slice(-5)}`;

  beforeAll(async () => {
    handle2 = await buildTestApp();
    await handle2.prisma.user.update({
      where: { id: handle2.ownerId },
      data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) },
    });
    token2 = (
      await api2().post("/api/v1/auth/login").send({ phone: handle2.ownerPhone, password: "Pwd@2026!" })
    ).body.accessToken as string;
  });
  afterAll(async () => teardownTestApp(handle2));

  it("creates NO variant when no size is supplied (the standalone form)", async () => {
    const res = await create2({ code: code2(), colorNameAr: "بدون مقاس", initialPurchasePricePerMeter: "400" });
    expect(res.status).toBe(201);
    expect(res.body.firstVariant).toBeUndefined();
    expect(await handle2.prisma.productVariant.count({ where: { skuId: res.body.id } })).toBe(0);
  });

  it("creates exactly ONE variant at the size the user actually typed", async () => {
    const res = await create2({
      code: code2(),
      colorNameAr: "بمقاس",
      initialPurchasePricePerMeter: "498.50",
      firstVariant: { sizeMetersPerBoard: "5.25" },
    });
    expect(res.status).toBe(201);
    expect(res.body.firstVariant.sizeMetersPerBoard).toBe("5.25");
    const variants = await handle2.prisma.productVariant.findMany({ where: { skuId: res.body.id } });
    expect(variants).toHaveLength(1);
    expect(variants[0]!.sizeMetersPerBoard.toString()).toBe("5.25");
    // the typed purchase price carries onto the variant; the sale price is not invented
    expect(variants[0]!.defaultPurchasePricePerMeter.toString()).toBe("498.5");
    expect(variants[0]!.defaultSalePricePerMeter.toString()).toBe("0");
  });

  it("still creates no stock, no movement and no posting", async () => {
    const before = {
      balances: await handle2.prisma.branchInventoryBalance.count(),
      movements: await handle2.prisma.inventoryMovement.count(),
      journals: await handle2.prisma.journalEntry.count(),
      purchases: await handle2.prisma.purchaseInvoice.count(),
    };
    await create2({
      code: code2(),
      colorNameAr: "بلا مخزون",
      initialPurchasePricePerMeter: "300",
      firstVariant: { sizeMetersPerBoard: "4" },
    });
    expect(await handle2.prisma.branchInventoryBalance.count()).toBe(before.balances);
    expect(await handle2.prisma.inventoryMovement.count()).toBe(before.movements);
    expect(await handle2.prisma.journalEntry.count()).toBe(before.journals);
    expect(await handle2.prisma.purchaseInvoice.count()).toBe(before.purchases);
  });

  it("rolls back the product too when the size is unusable", async () => {
    const code = code2();
    const res = await create2({
      code,
      colorNameAr: "مقاس خاطئ",
      firstVariant: { sizeMetersPerBoard: "abc" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    // neither half survived
    expect(await handle2.prisma.productSku.count({ where: { code } })).toBe(0);
  });

  it("the new product is immediately usable as a purchase line variant", async () => {
    const res = await create2({
      code: code2(),
      colorNameAr: "جاهز للشراء",
      initialPurchasePricePerMeter: "450",
      firstVariant: { sizeMetersPerBoard: "3.75" },
    });
    const listed = await api2().get("/api/v1/products/variants").set("Authorization", `Bearer ${token2}`);
    expect(listed.body.some((v: { id: string }) => v.id === res.body.firstVariant.id)).toBe(true);
  });
});
