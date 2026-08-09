/**
 * Product catalogue ↔ purchases ↔ sales synchronisation.
 *
 * The bug: a product created in «إدارة الأصناف» never appeared in the purchase
 * invoice, because the picker was fed by ProductVariant rows and a brand-new
 * product legitimately has none. Buying is precisely where a product's first
 * size arrives, so purchases must start from the base product.
 *
 * Sales is the opposite question and must stay the opposite answer: a product
 * with no stock in the chosen branch is not sellable there, however new or
 * active it is.
 *
 * These two rules are easy to conflate, so most of this suite is about keeping
 * them apart.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, openCurrentPeriod, type TestApp } from "./test-app";

describe("product catalogue ↔ purchase ↔ sales sync", () => {
  let h: TestApp;
  let ownerToken: string;
  let supplierId: string;
  let branchB: string;

  const server = () => h.app.getHttpServer();
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const u = Date.now().toString().slice(-6);

  const get = (p: string, token = ownerToken) => request(server()).get(`/api/v1${p}`).set(H(token));
  const post = (p: string, body: unknown, token = ownerToken) =>
    request(server()).post(`/api/v1${p}`).set(H(token)).send(body);

  /** Creates a base product exactly as إدارة الأصناف does — no size. */
  const createSku = (code: string, nameAr = `صنف ${code}`, price?: string) =>
    post("/products/skus", {
      code,
      colorNameAr: nameAr,
      ...(price ? { initialPurchasePricePerMeter: price } : {}),
    });

  const purchaseCatalogue = async () => (await get("/products/purchase-catalogue")).body.products;
  const salesAvailability = async (branchId: string, token = ownerToken) =>
    get(`/sales-invoices/available-products?branchId=${branchId}`, token);

  beforeAll(async () => {
    h = await buildTestApp();
    const pw = "Pwd@2026!";
    await h.prisma.user.update({
      where: { id: h.ownerId },
      data: { passwordHash: await bcrypt.hash(pw, 10) },
    });
    ownerToken = (
      await request(server()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: pw })
    ).body.accessToken;

    supplierId = (
      await h.prisma.supplier.create({ data: { nameAr: `مورد ${u}`, nameEn: `sup-${u}` } })
    ).id;
    branchB = (
      await h.prisma.branch.create({ data: { nameAr: "فرع ثانٍ", nameEn: "Second", active: true } })
    ).id;
    await h.prisma.userBranchAccess.create({ data: { userId: h.ownerId, branchId: branchB } });

    // Posting configuration — confirming a purchase posts to the ledger, and
    // the engine refuses without the control accounts it needs.
    const acc = (code: string, nameAr: string, cat: string, t: string, role?: string) =>
      h.prisma.account.create({
        data: {
          code,
          nameAr,
          nameEn: nameAr,
          category: cat as never,
          accountType: t as never,
          isLeaf: true,
          active: true,
          ...(role ? { systemRole: role as never } : {}),
        },
      });
    const arAccountId = (await acc(`AR${u}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    const apAccountId = (await acc(`AP${u}`, "موردون", "LIABILITY", "LIABILITY", "AP_CONTROL")).id;
    const revenueAccountId = (await acc(`REV${u}`, "مبيعات", "REVENUE", "REVENUE")).id;
    const inventoryAccountId = (await acc(`INV${u}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;
    const cogsAccountId = (await acc(`COGS${u}`, "تكلفة", "COST_OF_SALES", "COST_OF_SALES")).id;
    const vatInputAccountId = (await acc(`VAT${u}`, "ضريبة مشتريات", "ASSET", "CURRENT_ASSET")).id;
    await h.prisma.postingProfile.create({
      data: {
        effectiveFrom: new Date("2026-01-01"),
        arAccountId,
        apAccountId,
        revenueAccountId,
        inventoryAccountId,
        cogsAccountId,
        vatInputAccountId,
        createdBy: h.ownerId,
      },
    });
    await openCurrentPeriod(h);
  });

  afterAll(async () => teardownTestApp(h));

  /** Posts and confirms a purchase, buying `size` metres per board. */
  const buy = async (
    line: Record<string, unknown>,
    branchId = h.branchId,
    invoiceDate = new Date().toISOString().slice(0, 10),
  ) => {
    const created = await post("/purchase-invoices", {
      invoiceDate,
      supplierId,
      branchId,
      lines: [{ boardsQuantity: "10", unitPrice: "100", taxRate: "0", ...line }],
    });
    if (created.status !== 201) return created;
    return post(`/purchase-invoices/${created.body.id}/confirm`, {});
  };

  // ── 1. the reported bug ──────────────────────────────────────────────────

  it("1) a brand-new product with no sizes appears in the purchase catalogue", async () => {
    const sku = await createSku(`NEW${u}`);
    expect(sku.status).toBe(201);

    const products = await purchaseCatalogue();
    const found = products.find((p: { productSkuId: string }) => p.productSkuId === sku.body.id);
    expect(found).toBeDefined();
    expect(found.variants).toEqual([]);
    expect(found.code).toBe(`NEW${u}`);
  });

  it("1b) creating a product creates no variant, no balance, no movement", async () => {
    const before = {
      variants: await h.prisma.productVariant.count(),
      balances: await h.prisma.branchInventoryBalance.count(),
      movements: await h.prisma.inventoryMovement.count(),
      journals: await h.prisma.journalEntry.count(),
    };
    const sku = await createSku(`BARE${u}`);
    expect(sku.status).toBe(201);

    expect(await h.prisma.productVariant.count()).toBe(before.variants);
    expect(await h.prisma.branchInventoryBalance.count()).toBe(before.balances);
    expect(await h.prisma.inventoryMovement.count()).toBe(before.movements);
    expect(await h.prisma.journalEntry.count()).toBe(before.journals);
    // …and specifically none for this product.
    expect(await h.prisma.productVariant.count({ where: { skuId: sku.body.id } })).toBe(0);
  });

  it("2) a product with several sizes appears exactly once, with its sizes nested", async () => {
    const sku = await createSku(`MULTI${u}`);
    for (const size of ["5.25", "4", "3.75"]) {
      await h.prisma.productVariant.create({
        data: {
          skuId: sku.body.id,
          sizeMetersPerBoard: size,
          defaultSalePricePerMeter: "0",
          defaultPurchasePricePerMeter: "80",
        },
      });
    }
    const products = await purchaseCatalogue();
    const rows = products.filter((p: { productSkuId: string }) => p.productSkuId === sku.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].variants).toHaveLength(3);
    expect(rows[0].variants.map((v: { sizeMetersPerBoard: string }) => v.sizeMetersPerBoard)).toEqual([
      "3.7500",
      "4.0000",
      "5.2500",
    ]);
  });

  it("3) an inactive product is not offered for purchase, nor are retired sizes", async () => {
    const sku = await createSku(`OFF${u}`);
    const live = await h.prisma.productVariant.create({
      data: { skuId: sku.body.id, sizeMetersPerBoard: "5.25", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "80" },
    });
    const retired = await h.prisma.productVariant.create({
      data: { skuId: sku.body.id, sizeMetersPerBoard: "4", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "80", active: false },
    });

    let row = (await purchaseCatalogue()).find((p: { productSkuId: string }) => p.productSkuId === sku.body.id);
    expect(row.variants.map((v: { productVariantId: string }) => v.productVariantId)).toEqual([live.id]);
    expect(row.variants.map((v: { productVariantId: string }) => v.productVariantId)).not.toContain(retired.id);

    await request(server())
      .patch(`/api/v1/products/skus/${sku.body.id}`)
      .set(H(ownerToken))
      .send({ active: false });
    row = (await purchaseCatalogue()).find((p: { productSkuId: string }) => p.productSkuId === sku.body.id);
    expect(row).toBeUndefined();
  });

  it("4) a duplicate product code is refused and creates nothing", async () => {
    const code = `DUP${u}`;
    expect((await createSku(code)).status).toBe(201);
    const second = await createSku(code, "محاولة ثانية");
    expect(second.status).toBe(409);
    expect(await h.prisma.productSku.count({ where: { code } })).toBe(1);
  });

  it("5) concurrent creates of the same code cannot both win", async () => {
    const code = `RACE${u}`;
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => createSku(code, `سباق ${i}`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await h.prisma.productSku.count({ where: { code } })).toBe(1);
  });

  // ── the first purchase gives the product its first real size ─────────────

  it("6) buying a zero-variant product at a real size creates exactly that variant", async () => {
    const sku = await createSku(`FIRST${u}`, "صاج مجلفن", "90");
    expect(await h.prisma.productVariant.count({ where: { skuId: sku.body.id } })).toBe(0);

    const res = await buy({ productSkuId: sku.body.id, sizeMetersPerBoard: "5.25" });
    expect(res.status).toBeLessThan(300);

    const variants = await h.prisma.productVariant.findMany({ where: { skuId: sku.body.id } });
    expect(variants).toHaveLength(1);
    expect(variants[0]!.sizeMetersPerBoard.toFixed(4)).toBe("5.2500");
    // The starting purchase price comes from the catalogue, never invented.
    expect(variants[0]!.defaultPurchasePricePerMeter.toFixed(2)).toBe("90.00");
    // Still exactly one base product.
    expect(await h.prisma.productSku.count({ where: { code: `FIRST${u}` } })).toBe(1);

    // Stock landed on that exact variant, in that exact branch.
    const bal = await h.prisma.branchInventoryBalance.findUnique({
      where: { branchId_productVariantId: { branchId: h.branchId, productVariantId: variants[0]!.id } },
    });
    expect(bal!.boardsOnHand.toFixed(4)).toBe("10.0000");
  });

  it("7) buying the same product at a second size adds a second variant, not a second product", async () => {
    const sku = await createSku(`TWOSIZE${u}`);
    await buy({ productSkuId: sku.body.id, sizeMetersPerBoard: "5.25" });
    await buy({ productSkuId: sku.body.id, sizeMetersPerBoard: "4" });

    const variants = await h.prisma.productVariant.findMany({
      where: { skuId: sku.body.id },
      orderBy: { sizeMetersPerBoard: "asc" },
    });
    expect(variants.map((v) => v.sizeMetersPerBoard.toFixed(4))).toEqual(["4.0000", "5.2500"]);
    expect(await h.prisma.productSku.count({ where: { code: `TWOSIZE${u}` } })).toBe(1);

    // Independent stock per size — sizes are never merged.
    for (const v of variants) {
      const bal = await h.prisma.branchInventoryBalance.findUnique({
        where: { branchId_productVariantId: { branchId: h.branchId, productVariantId: v.id } },
      });
      expect(bal!.boardsOnHand.toFixed(4)).toBe("10.0000");
    }
  });

  it("8) buying an existing size reuses that exact variant rather than duplicating it", async () => {
    const sku = await createSku(`REUSE${u}`);
    await buy({ productSkuId: sku.body.id, sizeMetersPerBoard: "5.25" });
    const first = await h.prisma.productVariant.findMany({ where: { skuId: sku.body.id } });
    expect(first).toHaveLength(1);

    // "5.2500" is the same size as "5.25" and must find the same row.
    await buy({ productSkuId: sku.body.id, sizeMetersPerBoard: "5.2500" });
    const after = await h.prisma.productVariant.findMany({ where: { skuId: sku.body.id } });
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first[0]!.id);

    const bal = await h.prisma.branchInventoryBalance.findUnique({
      where: { branchId_productVariantId: { branchId: h.branchId, productVariantId: first[0]!.id } },
    });
    expect(bal!.boardsOnHand.toFixed(4)).toBe("20.0000");
  });

  it("9) naming an exact variant still works, unchanged", async () => {
    const sku = await createSku(`EXACT${u}`);
    const variant = await h.prisma.productVariant.create({
      data: { skuId: sku.body.id, sizeMetersPerBoard: "4", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "70" },
    });
    const res = await buy({ productVariantId: variant.id });
    expect(res.status).toBeLessThan(300);
    expect(await h.prisma.productVariant.count({ where: { skuId: sku.body.id } })).toBe(1);
  });

  it("10) a retired size is never revived by a purchase", async () => {
    const sku = await createSku(`RETIRED${u}`);
    await h.prisma.productVariant.create({
      data: { skuId: sku.body.id, sizeMetersPerBoard: "5.25", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "80", active: false },
    });
    const res = await buy({ productSkuId: sku.body.id, sizeMetersPerBoard: "5.25" });
    expect(res.status).toBe(409);
    expect(res.body.details.reason).toBe("VARIANT_INACTIVE");
    // Still retired, and still the only one.
    const variants = await h.prisma.productVariant.findMany({ where: { skuId: sku.body.id } });
    expect(variants).toHaveLength(1);
    expect(variants[0]!.active).toBe(false);
  });

  it("11) an inactive product cannot be purchased", async () => {
    const sku = await createSku(`INACT${u}`);
    await request(server())
      .patch(`/api/v1/products/skus/${sku.body.id}`)
      .set(H(ownerToken))
      .send({ active: false });
    const res = await buy({ productSkuId: sku.body.id, sizeMetersPerBoard: "5.25" });
    expect(res.status).toBe(409);
    expect(res.body.details.reason).toBe("PRODUCT_INACTIVE");
    expect(await h.prisma.productVariant.count({ where: { skuId: sku.body.id } })).toBe(0);
  });

  // ── sales is the opposite question ───────────────────────────────────────

  it("12) a catalogue product with no stock is NOT sellable", async () => {
    const sku = await createSku(`NOSTOCK${u}`);
    const res = await salesAvailability(h.branchId);
    expect(res.status).toBe(200);
    expect(res.body.variants.some((v: { skuId: string }) => v.skuId === sku.body.id)).toBe(false);
  });

  it("13) once it has real stock, a newly created product becomes sellable", async () => {
    const sku = await createSku(`SELLABLE${u}`);
    // Not sellable before…
    let res = await salesAvailability(h.branchId);
    expect(res.body.variants.some((v: { skuId: string }) => v.skuId === sku.body.id)).toBe(false);

    await buy({ productSkuId: sku.body.id, sizeMetersPerBoard: "5.25" });

    // …and sellable straight after, with no catalogue repair of any kind.
    res = await salesAvailability(h.branchId);
    const offered = res.body.variants.filter((v: { skuId: string }) => v.skuId === sku.body.id);
    expect(offered).toHaveLength(1);
    expect(offered[0].sizeMetersPerBoard).toBe("5.2500");
    expect(Number(offered[0].boardsOnHand)).toBeGreaterThan(0);
  });

  it("14) stock in one branch does not make the product sellable in another", async () => {
    const sku = await createSku(`BRANCHED${u}`);
    await buy({ productSkuId: sku.body.id, sizeMetersPerBoard: "5.25" }, h.branchId);

    const here = await salesAvailability(h.branchId);
    const there = await salesAvailability(branchB);
    expect(here.body.variants.some((v: { skuId: string }) => v.skuId === sku.body.id)).toBe(true);
    expect(there.body.variants.some((v: { skuId: string }) => v.skuId === sku.body.id)).toBe(false);
  });

  it("15) only the exact stocked size is offered, not its siblings", async () => {
    const sku = await createSku(`ONESIZE${u}`);
    await buy({ productSkuId: sku.body.id, sizeMetersPerBoard: "5.25" });
    // A second size exists in the catalogue but was never bought.
    await h.prisma.productVariant.create({
      data: { skuId: sku.body.id, sizeMetersPerBoard: "4", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "80" },
    });

    const res = await salesAvailability(h.branchId);
    const sizes = res.body.variants
      .filter((v: { skuId: string }) => v.skuId === sku.body.id)
      .map((v: { sizeMetersPerBoard: string }) => v.sizeMetersPerBoard);
    expect(sizes).toEqual(["5.2500"]);
  });

  it("16) a size whose stock is gone stops being offered", async () => {
    const sku = await createSku(`DRAIN${u}`);
    await buy({ productSkuId: sku.body.id, sizeMetersPerBoard: "5.25" });
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId: sku.body.id } }))[0]!;

    expect(
      (await salesAvailability(h.branchId)).body.variants.some(
        (v: { id: string }) => v.id === variant.id,
      ),
    ).toBe(true);

    // Take the stock out the way the system does, through the engine.
    await post("/inventory/adjustments", {
      branchId: h.branchId,
      productVariantId: variant.id,
      boardsDelta: "-10",
      note: "استهلاك كامل",
    });

    expect(
      (await salesAvailability(h.branchId)).body.variants.some(
        (v: { id: string }) => v.id === variant.id,
      ),
    ).toBe(false);
  });

  it("17) an inactive product is not sellable even while it still holds stock", async () => {
    const sku = await createSku(`SELLOFF${u}`);
    await buy({ productSkuId: sku.body.id, sizeMetersPerBoard: "5.25" });
    expect(
      (await salesAvailability(h.branchId)).body.variants.some((v: { skuId: string }) => v.skuId === sku.body.id),
    ).toBe(true);

    await request(server())
      .patch(`/api/v1/products/skus/${sku.body.id}`)
      .set(H(ownerToken))
      .send({ active: false });

    expect(
      (await salesAvailability(h.branchId)).body.variants.some((v: { skuId: string }) => v.skuId === sku.body.id),
    ).toBe(false);
  });

  it("18) sales availability is one query, and reading it writes nothing", async () => {
    const before = {
      variants: await h.prisma.productVariant.count(),
      balances: await h.prisma.branchInventoryBalance.count(),
      movements: await h.prisma.inventoryMovement.count(),
    };
    for (let i = 0; i < 3; i += 1) {
      expect((await salesAvailability(h.branchId)).status).toBe(200);
      expect((await get("/products/purchase-catalogue")).body.committedChanges).toBe(0);
    }
    expect(await h.prisma.productVariant.count()).toBe(before.variants);
    expect(await h.prisma.branchInventoryBalance.count()).toBe(before.balances);
    expect(await h.prisma.inventoryMovement.count()).toBe(before.movements);
  });

  it("19) a user cannot read stock for a branch they have no access to", async () => {
    const otherBranch = await h.prisma.branch.create({
      data: { nameAr: "فرع بعيد", nameEn: "Far", active: true },
    });
    const pw = "Pwd@2026!";
    const outsider = await h.prisma.user.create({
      data: {
        name: "محاسب",
        phone: `+2017${u}`,
        passwordHash: await bcrypt.hash(pw, 10),
        role: "ACCOUNTANT" as never,
        status: "ACTIVE",
        branchAccesses: { create: { branchId: otherBranch.id } },
      },
    });
    const token = (
      await request(server()).post("/api/v1/auth/login").send({ phone: outsider.phone, password: pw })
    ).body.accessToken;

    expect((await salesAvailability(otherBranch.id, token)).status).toBe(200);
    expect((await salesAvailability(h.branchId, token)).status).toBe(403);
  });

  it("20) the purchase catalogue and sales availability disagree, on purpose", async () => {
    const sku = await createSku(`CONTRAST${u}`);
    const inPurchase = (await purchaseCatalogue()).some(
      (p: { productSkuId: string }) => p.productSkuId === sku.body.id,
    );
    const inSales = (await salesAvailability(h.branchId)).body.variants.some(
      (v: { skuId: string }) => v.skuId === sku.body.id,
    );
    // Buyable because buying is how it gets stock; not sellable because it has none.
    expect(inPurchase).toBe(true);
    expect(inSales).toBe(false);
  });
});
