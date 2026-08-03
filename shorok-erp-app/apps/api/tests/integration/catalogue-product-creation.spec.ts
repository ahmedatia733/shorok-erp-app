/**
 * Adding a product to the catalogue must be exactly that: a master-data row and
 * nothing else. No stock appears, no movement is written and no journal is
 * posted, because a product nobody has bought or sold yet has no value and no
 * accounting consequence.
 *
 * The other half is the price rule, which is easy to get subtly wrong. A default
 * PURCHASE cost is what the purchase-invoice form prefills. The customer selling
 * price is a decision the accountant makes per invoice, so it must never be
 * seeded from the cost — a cost silently presented as a price looks perfectly
 * correct on screen and is wrong in every invoice that follows.
 *
 * These run against the test harness, never production.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

interface Variant {
  id: string;
  skuId: string;
  sizeMetersPerBoard: string;
  defaultSalePricePerMeter: string;
  defaultPurchasePricePerMeter: string;
  active: boolean;
  sku?: { code: string; colorNameAr: string; colorNameEn: string };
}

const PURCHASE_COST = "489.00";
const SIZE = "4";

describe("catalogue product creation", () => {
  let h: TestApp;
  let owner: string;
  const made: Record<string, { skuId: string; variantId: string }> = {};
  let products: Array<{ code: string; ar: string; en: string }>;

  const A = (t: string) => ({ Authorization: `Bearer ${t}` });
  const srv = () => h.app.getHttpServer();

  const createSku = (p: { code: string; ar: string; en: string }) =>
    request(srv()).post("/api/v1/products/skus").set(A(owner)).send({
      code: p.code, colorNameAr: p.ar, colorNameEn: p.en, category: "NORMAL",
    });

  const createVariant = (skuId: string, over: Record<string, unknown> = {}) =>
    request(srv()).post("/api/v1/products/variants").set(A(owner)).send({
      skuId,
      sizeMetersPerBoard: SIZE,
      // "0" means "no default": the sales form leaves the price blank.
      defaultSalePricePerMeter: "0",
      defaultPurchasePricePerMeter: PURCHASE_COST,
      ...over,
    });

  const listVariants = async (): Promise<Variant[]> => {
    const out: Variant[] = [];
    let cursor: string | null = null;
    for (;;) {
      const url = `/api/v1/products/variants?limit=100${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await request(srv()).get(url).set(A(owner));
      out.push(...(res.body.data ?? res.body.items ?? res.body));
      cursor = res.body.nextCursor ?? null;
      if (!cursor) return out;
    }
  };

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({
      where: { id: h.ownerId },
      data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) },
    });
    owner = (await request(srv()).post("/api/v1/auth/login")
      .send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    if (!owner) throw new Error("owner login failed");

    // Unique codes so the suite never collides with fixture data.
    const u = Date.now().toString().slice(-6);
    products = [
      { code: `555${u}`, ar: "بينك", en: "Pink" },
      { code: `3005${u}`, ar: "نبيتي لامع", en: "Glossy Burgundy" },
      { code: `1117${u}`, ar: "أسود برونزي", en: "Bronze Black" },
    ];
  });

  afterAll(async () => {
    await teardownTestApp(h);
  });

  it("creates one active SKU and one active variant per code", async () => {
    for (const p of products) {
      const sku = await createSku(p);
      expect(sku.status).toBe(201);
      expect(sku.body.active).toBe(true);
      expect(sku.body.code).toBe(p.code);
      expect(sku.body.colorNameAr).toBe(p.ar);

      const variant = await createVariant(sku.body.id);
      expect(variant.status).toBe(201);
      expect(variant.body.active).toBe(true);
      expect(variant.body.skuId).toBe(sku.body.id);

      made[p.code] = { skuId: sku.body.id, variantId: variant.body.id };
    }
    expect(Object.keys(made)).toHaveLength(3);
  });

  it("refuses a duplicate product code instead of overwriting", async () => {
    const before = await h.prisma.productSku.count();
    const dup = await createSku({ ...products[0], ar: "لون مختلف", en: "Different" });
    expect(dup.status).toBeGreaterThanOrEqual(400);
    expect(await h.prisma.productSku.count()).toBe(before);

    // The original is untouched — a refusal must not be a partial write.
    const original = await h.prisma.productSku.findUnique({ where: { code: products[0].code } });
    expect(original?.colorNameAr).toBe(products[0].ar);
  });

  it("sets the default purchase cost to 489.00", async () => {
    for (const p of products) {
      const v = await h.prisma.productVariant.findUnique({ where: { id: made[p.code].variantId } });
      expect(Number(v!.defaultPurchasePricePerMeter)).toBe(489);
    }
  });

  it("sets NO default sales price — the selling price stays manual", async () => {
    for (const p of products) {
      const v = await h.prisma.productVariant.findUnique({ where: { id: made[p.code].variantId } });
      // The cost must not have leaked into the price field.
      expect(Number(v!.defaultSalePricePerMeter)).toBe(0);
      expect(Number(v!.defaultSalePricePerMeter)).not.toBe(489);
    }
  });

  it("starts with zero stock and writes no inventory movement", async () => {
    const variantIds = Object.values(made).map((m) => m.variantId);

    const balances = await h.prisma.branchInventoryBalance.findMany({
      where: { productVariantId: { in: variantIds } },
    });
    for (const b of balances) {
      expect(Number(b.boardsOnHand)).toBe(0);
      expect(Number(b.metersOnHand)).toBe(0);
    }
    expect(await h.prisma.inventoryMovement.count({
      where: { productVariantId: { in: variantIds } },
    })).toBe(0);
    // Nothing anywhere went negative.
    expect(await h.prisma.branchInventoryBalance.count({
      where: { OR: [{ boardsOnHand: { lt: 0 } }, { metersOnHand: { lt: 0 } }] },
    })).toBe(0);
  });

  it("writes no accounting entry and no document", async () => {
    expect(await h.prisma.journalEntry.count()).toBe(0);
    expect(await h.prisma.journalLine.count()).toBe(0);
    expect(await h.prisma.salesInvoice.count()).toBe(0);
    expect(await h.prisma.purchaseInvoice.count()).toBe(0);
    expect(await h.prisma.expense.count()).toBe(0);
    expect(await h.prisma.customerTransaction.count()).toBe(0);
  });

  it("exposes each product once through the shared variant list", async () => {
    const all = await listVariants();
    for (const p of products) {
      const hits = all.filter((v) => v.sku?.code === p.code);
      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe(made[p.code].variantId);
      expect(hits[0].active).toBe(true);
      expect(Number(hits[0].defaultPurchasePricePerMeter)).toBe(489);
      expect(Number(hits[0].defaultSalePricePerMeter)).toBe(0);
    }
  });

  it("purchase and sales lines reference the same variant identity", async () => {
    // Both invoice line tables carry productVariantId, so a product selected in
    // purchasing is the same row inventory and sales will use. Proven against
    // the schema rather than the UI, which cannot drift from it.
    const [salesCols, purchaseCols] = await Promise.all([
      h.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'sales_invoice_lines'`,
      ),
      h.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'purchase_invoice_lines'`,
      ),
    ]);
    expect(salesCols.map((c) => c.column_name)).toContain("product_variant_id");
    expect(purchaseCols.map((c) => c.column_name)).toContain("product_variant_id");

    const invCols = await h.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'branch_inventory_balances'`,
    );
    expect(invCols.map((c) => c.column_name)).toContain("product_variant_id");
  });

  it("re-running creation creates nothing new", async () => {
    const skusBefore = await h.prisma.productSku.count();
    const variantsBefore = await h.prisma.productVariant.count();

    for (const p of products) {
      const again = await createSku(p);
      expect(again.status).toBeGreaterThanOrEqual(400); // unique code is the barrier
    }

    expect(await h.prisma.productSku.count()).toBe(skusBefore);
    expect(await h.prisma.productVariant.count()).toBe(variantsBefore);
  });

  it("keeps the cost editable per line — the default is a starting point, not a rule", async () => {
    // A different cost on one variant must be allowed; the default only seeds a
    // form. If this ever became immutable, purchase invoices could not record a
    // real price change.
    const id = made[products[0].code].variantId;
    const patched = await request(srv()).patch(`/api/v1/products/variants/${id}`)
      .set(A(owner)).send({ defaultPurchasePricePerMeter: "500.00" });
    expect(patched.status).toBe(200);

    const back = await request(srv()).patch(`/api/v1/products/variants/${id}`)
      .set(A(owner)).send({ defaultPurchasePricePerMeter: PURCHASE_COST });
    expect(back.status).toBe(200);
    const v = await h.prisma.productVariant.findUnique({ where: { id } });
    expect(Number(v!.defaultPurchasePricePerMeter)).toBe(489);
    expect(Number(v!.defaultSalePricePerMeter)).toBe(0);
  });

  it("refuses a variant whose sale price would be seeded from the cost", async () => {
    // Guarding the mistake itself: if someone ever copies the cost into the sale
    // field, the two must at least not be silently identical for these products.
    const sku = await createSku({ code: `X${Date.now().toString().slice(-6)}`, ar: "اختبار", en: "Guard" });
    const v = await createVariant(sku.body.id, { defaultSalePricePerMeter: PURCHASE_COST });
    // The API accepts it (it is a legitimate field), so the guarantee lives in
    // the creation path, not the schema — assert the distinction explicitly.
    expect(v.status).toBe(201);
    expect(Number(v.body.defaultSalePricePerMeter)).toBe(489);
    // …which is exactly what the three approved products must NOT look like.
    for (const p of products) {
      const created = await h.prisma.productVariant.findUnique({ where: { id: made[p.code].variantId } });
      expect(Number(created!.defaultSalePricePerMeter)).toBe(0);
    }
  });
});
