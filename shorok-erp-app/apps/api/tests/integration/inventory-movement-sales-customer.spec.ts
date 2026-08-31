/**
 * حركات المخزون — who a sale was to.
 *
 * Every sale row used to read «فاتورة مبيعات», which is true of all of them and
 * therefore identifies none of them. The customer is resolved at read time from
 * the invoice the movement already points at, so historical rows gain the name
 * without being touched — these tests assert exactly that, and that nothing
 * else about a movement changes.
 *
 * The resolution is batched: one invoice lookup per page, never one per row.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, openCurrentPeriod, teardownTestApp, type TestApp } from "./test-app";

describe("inventory movements — the customer behind a sale", () => {
  let h: TestApp;
  let token: string;
  let variantBig: string;
  let variantSmall: string;
  let ahmedId: string;
  let mohamedId: string;
  let ahmedInvoice: string;
  const u = Date.now().toString().slice(-6);
  const CODE = `CUS-${u}`;
  const AHMED = `أحمد محمد ${u}`;
  const MOHAMED = `محمد علي ${u}`;

  const srv = () => h.app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const post = (p: string, b: unknown) => request(srv()).post(`/api/v1${p}`).set(auth()).send(b);
  const movements = (params: Record<string, string> = {}) =>
    request(srv()).get("/api/v1/inventory/movements").query({ limit: "200", ...params }).set(auth());

  const names = (body: { data: Array<{ salesDocument: { customerName: string } | null }> }) =>
    [...new Set(body.data.map((m) => m.salesDocument?.customerName).filter(Boolean))].sort();

  beforeAll(async () => {
    h = await buildTestApp();
    await openCurrentPeriod(h);
    const pw = "Pwd@2026!";
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash(pw, 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: pw })).body
      .accessToken as string;

    // A complete posting profile, or confirming an invoice has nowhere to post.
    const acc = (code: string, nameAr: string, cat: string, t: string, role?: string) =>
      h.prisma.account.create({
        data: { code, nameAr, nameEn: nameAr, category: cat as never, accountType: t as never, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) },
      });
    await h.prisma.postingProfile.create({
      data: {
        effectiveFrom: new Date("2020-01-01"),
        arAccountId: (await acc(`AR${u}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id,
        apAccountId: (await acc(`AP${u}`, "موردون", "LIABILITY", "LIABILITY", "AP_CONTROL")).id,
        revenueAccountId: (await acc(`REV${u}`, "مبيعات", "REVENUE", "REVENUE")).id,
        inventoryAccountId: (await acc(`INV${u}`, "مخزون", "ASSET", "CURRENT_ASSET")).id,
        cogsAccountId: (await acc(`COGS${u}`, "تكلفة", "COST_OF_SALES", "COST_OF_SALES")).id,
        vatOutputAccountId: (await acc(`VATO${u}`, "ض.ق.م", "LIABILITY", "LIABILITY")).id,
        vatInputAccountId: (await acc(`VATI${u}`, "ض.مدخلات", "ASSET", "CURRENT_ASSET")).id,
        createdBy: h.ownerId,
      },
    });

    // The dated documents below need their periods open; the guard is canonical.
    await h.prisma.financialPeriod.createMany({
      data: [
        { year: 2026, month: 2, status: "OPEN" },
        { year: 2026, month: 3, status: "OPEN" },
      ],
      skipDuplicates: true,
    });

    const skuRes = await post("/products/skus", { code: CODE, colorNameAr: "لون", colorNameEn: "Colour", category: "NORMAL" });
    if (skuRes.status >= 300) throw new Error(`sku ${skuRes.status} ${JSON.stringify(skuRes.body)}`);
    const sku = skuRes.body;
    variantBig = (await post("/products/variants", { skuId: sku.id, sizeMetersPerBoard: "5.25", defaultSalePricePerMeter: "500", defaultPurchasePricePerMeter: "300" })).body.id;
    variantSmall = (await post("/products/variants", { skuId: sku.id, sizeMetersPerBoard: "4", defaultSalePricePerMeter: "500", defaultPurchasePricePerMeter: "300" })).body.id;

    const supplierId = (await post("/suppliers", { nameAr: `مورد ${u}`, nameEn: `Sup ${u}` })).body.id;
    for (const v of [variantBig, variantSmall]) {
      const pi = await post("/purchase-invoices", {
        invoiceDate: "2026-02-05", supplierId, branchId: h.branchId,
        lines: [{ productVariantId: v, boardsQuantity: "40", unitPrice: "300", taxRate: "0" }],
      });
      if (pi.status >= 300) throw new Error(`pi ${pi.status} ${JSON.stringify(pi.body)}`);
      const pc = await post(`/purchase-invoices/${pi.body.id}/confirm`, {});
      if (pc.status >= 300) throw new Error(`pi confirm ${pc.status} ${JSON.stringify(pc.body)}`);
    }

    ahmedId = (await post("/customers", { nameAr: AHMED })).body.id;
    mohamedId = (await post("/customers", { nameAr: MOHAMED })).body.id;

    // Ahmed buys one of each size; Mohamed buys only the small one.
    const a = await post("/sales-invoices", {
      invoiceDate: "2026-03-05", customerId: ahmedId, branchId: h.branchId, taxRate: "0",
      lines: [
        { productVariantId: variantBig, quantity: "2", unitPrice: "500", costPrice: "0" },
        { productVariantId: variantSmall, quantity: "3", unitPrice: "500", costPrice: "0" },
      ],
    });
    if (a.status >= 300) throw new Error(`si-a ${a.status} ${JSON.stringify(a.body)}`);
    const ac = await post(`/sales-invoices/${a.body.id}/confirm`, {});
    if (ac.status >= 300) throw new Error(`si-a confirm ${ac.status} ${JSON.stringify(ac.body)}`);
    ahmedInvoice = a.body.id;

    const m = await post("/sales-invoices", {
      invoiceDate: "2026-03-06", customerId: mohamedId, branchId: h.branchId, taxRate: "0",
      lines: [{ productVariantId: variantSmall, quantity: "1", unitPrice: "500", costPrice: "0" }],
    });
    await post(`/sales-invoices/${m.body.id}/confirm`, {});
  });

  afterAll(async () => teardownTestApp(h));

  // ── the resolved customer ────────────────────────────────────────────────

  it("a sale movement carries the customer the invoice was issued to", async () => {
    const res = await movements({ search: CODE });
    expect(res.status).toBe(200);
    const sales = res.body.data.filter((m: { referenceType: string }) => m.referenceType === "sales_invoice");
    expect(sales.length).toBeGreaterThan(0);
    for (const m of sales) {
      expect(m.salesDocument).toBeTruthy();
      expect([AHMED, MOHAMED]).toContain(m.salesDocument.customerName);
      expect(m.salesDocument.invoiceNumber).toMatch(/^\d+$/);
      expect(m.salesDocument.customerCode).toBeTruthy();
    }
  });

  it("two customers' movements do not borrow each other's name", async () => {
    const res = await movements({ search: CODE });
    const byInvoice = new Map<string, Set<string>>();
    for (const m of res.body.data) {
      if (!m.salesDocument) continue;
      const set = byInvoice.get(m.salesDocument.invoiceNumber) ?? new Set<string>();
      set.add(m.salesDocument.customerName);
      byInvoice.set(m.salesDocument.invoiceNumber, set);
    }
    // one invoice, one customer — never a mixture
    for (const [, set] of byInvoice) expect(set.size).toBe(1);
    expect(names(res.body)).toEqual([AHMED, MOHAMED].sort());
  });

  it("the invoice number stays available for audit", async () => {
    const res = await movements({ search: CODE });
    const inv = await h.prisma.salesInvoice.findUnique({ where: { id: ahmedInvoice } });
    const mine = res.body.data.filter((m: { referenceId: string }) => m.referenceId === ahmedInvoice);
    expect(mine.length).toBeGreaterThan(0);
    for (const m of mine) expect(m.salesDocument.invoiceNumber).toBe(inv!.invoiceNumber.toString());
  });

  it("the reference identity is untouched, so the link still points at the invoice", async () => {
    const res = await movements({ search: CODE });
    const mine = res.body.data.filter((m: { referenceId: string }) => m.referenceId === ahmedInvoice);
    for (const m of mine) {
      expect(m.referenceType).toBe("sales_invoice");
      expect(m.referenceId).toBe(ahmedInvoice);
    }
  });

  // ── everything else keeps its own identity ───────────────────────────────

  it("purchases, transfers and returns carry no customer", async () => {
    const res = await movements({ search: CODE });
    for (const m of res.body.data) {
      if (m.referenceType === "sales_invoice") continue;
      expect(m.salesDocument).toBeNull();
    }
    const purchases = res.body.data.filter((m: { referenceType: string }) => m.referenceType === "purchase_invoice");
    expect(purchases.length).toBeGreaterThan(0);
    for (const m of purchases) expect(m.salesDocument).toBeNull();
  });

  it("the board size the previous feature added is still there", async () => {
    const res = await movements({ search: CODE });
    for (const m of res.body.data) {
      expect(["BIG", "SMALL", "CUSTOM"]).toContain(m.boardSize.kind);
    }
    expect(res.body.data.some((m: { boardSize: { shortAr: string } }) => m.boardSize.shortAr === "ك")).toBe(true);
    expect(res.body.data.some((m: { boardSize: { shortAr: string } }) => m.boardSize.shortAr === "ص")).toBe(true);
  });

  // ── searching by customer ────────────────────────────────────────────────

  it("a customer name finds that customer's sale movements", async () => {
    const res = await movements({ search: AHMED });
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(names(res.body)).toEqual([AHMED]);
  });

  it("a partial name works, and does not return the other customer", async () => {
    const res = await movements({ search: `أحمد ${u}` });
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(names(res.body)).toEqual([AHMED]);
  });

  it("customer plus product code intersects", async () => {
    const res = await movements({ search: `${CODE} ${AHMED}` });
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const m of res.body.data) {
      expect(m.productVariant.sku.code).toBe(CODE);
      expect(m.salesDocument?.customerName).toBe(AHMED);
    }
  });

  it("customer plus a size class intersects", async () => {
    const big = await movements({ search: `${AHMED} ك` });
    expect(big.body.data.length).toBeGreaterThan(0);
    for (const m of big.body.data) {
      expect(m.productVariant.sizeMetersPerBoard).toBe("5.25");
      expect(m.salesDocument?.customerName).toBe(AHMED);
    }
    const small = await movements({ search: `${AHMED} ص` });
    expect(small.body.data.length).toBeGreaterThan(0);
    for (const m of small.body.data) {
      expect(m.productVariant.sizeMetersPerBoard).toBe("4");
      expect(m.salesDocument?.customerName).toBe(AHMED);
    }
  });

  it("a customer with no movements returns nothing rather than everything", async () => {
    const res = await movements({ search: `عميل لا وجود له ${u}` });
    expect(res.body.data).toHaveLength(0);
  });

  it("the existing searches still behave", async () => {
    expect((await movements({ search: CODE })).body.data.length).toBeGreaterThan(0);
    const big = await movements({ search: `${CODE} ك` });
    for (const m of big.body.data) expect(m.productVariant.sizeMetersPerBoard).toBe("5.25");
    const unfiltered = await movements();
    expect(unfiltered.body.data.length).toBeGreaterThan(0);
  });

  it("pagination stays inside the filtered set", async () => {
    const first = await movements({ search: CODE, limit: "2" });
    expect(first.body.data).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(srv())
      .get("/api/v1/inventory/movements")
      .query({ search: CODE, limit: "2", cursor: first.body.nextCursor })
      .set(auth());
    const ids = new Set([...first.body.data, ...second.body.data].map((m: { id: string }) => m.id));
    expect(ids.size).toBe(first.body.data.length + second.body.data.length);
  });

  // ── reading changes nothing ──────────────────────────────────────────────

  it("resolving customers alters no movement, invoice or customer", async () => {
    const snap = async () => ({
      movements: await h.prisma.inventoryMovement.findMany({
        select: { id: true, referenceType: true, referenceId: true, humanReadableNote: true, boardsQuantity: true },
        orderBy: { id: "asc" },
      }),
      invoices: await h.prisma.salesInvoice.findMany({
        select: { id: true, customerId: true, invoiceNumber: true, status: true },
        orderBy: { id: "asc" },
      }),
      customers: await h.prisma.customer.findMany({ select: { id: true, code: true, nameAr: true }, orderBy: { id: "asc" } }),
    });
    const before = await snap();
    for (const q of [CODE, AHMED, MOHAMED, `${CODE} ك`, `أحمد ${u}`, ""]) {
      expect((await movements(q ? { search: q } : {})).status).toBe(200);
    }
    expect(await snap()).toEqual(before);
  });
});
