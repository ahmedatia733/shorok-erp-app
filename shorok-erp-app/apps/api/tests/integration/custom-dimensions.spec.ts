/**
 * Custom-dimension correctness: the EXACT effective meters used for an invoice
 * line's money must also be the meters posted to inventory — for كبير (5.25),
 * صغير (4.00) and custom طول×عرض — never boards × the variant's stored size.
 *
 * Uses a variant whose stored size is 1.0000 so a divergence would be obvious
 * (e.g. custom 2×1.5 = 6.00 vs the variant-size 2.00). Proves purchase RECEIPT,
 * sales SALE, cancellation reversal (exact meters), branch isolation, and that
 * editing the variant size never changes historical posted quantities.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("custom dimensions — financial meters == inventory meters", () => {
  let handle: TestApp;
  let token: string;
  let otherBranchId: string;
  let customerId: string, supplierId: string;
  let ar: string, ap: string, rev: string, vatOut: string, vatIn: string, cogs: string, invAcc: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => handle.app.getHttpServer();
  const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

  beforeAll(async () => {
    handle = await buildTestApp();
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;

    otherBranchId = (await handle.prisma.branch.create({ data: { nameAr: "فرع آخر", nameEn: "Other", active: true } })).id;
    customerId = (await handle.prisma.customer.create({ data: { code: "CD-C", nameAr: "عميل" } })).id;
    supplierId = (await handle.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;

    const u = Date.now().toString().slice(-6);
    const mk = (c: string, n: string, cat: any, t: any, role?: string) =>
      handle.prisma.account.create({ data: { code: c, nameAr: n, nameEn: n, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } });
    ar = (await mk(`AR${u}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    ap = (await mk(`AP${u}`, "موردون", "LIABILITY", "LIABILITY", "AP_CONTROL")).id;
    rev = (await mk(`RV${u}`, "مبيعات", "REVENUE", "REVENUE")).id;
    vatOut = (await mk(`VO${u}`, "ض مبيعات", "LIABILITY", "LIABILITY")).id;
    vatIn = (await mk(`VI${u}`, "ض مشتريات", "ASSET", "CURRENT_ASSET")).id;
    cogs = (await mk(`CG${u}`, "تكلفة", "COST_OF_SALES", "COST_OF_SALES")).id;
    invAcc = (await mk(`IN${u}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: ar, apAccountId: ap, revenueAccountId: rev, vatOutputAccountId: vatOut, vatInputAccountId: vatIn, cogsAccountId: cogs, inventoryAccountId: invAcc, createdBy: handle.ownerId } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });
  afterAll(async () => teardownTestApp(handle));

  let seq = 0;
  const freshVariant = async (size = "1.0000") => {
    const sku = await handle.prisma.productSku.create({ data: { code: `CD-${++seq}`, category: "NORMAL", colorNameAr: "ص", colorNameEn: "c" } });
    return (await handle.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: size, defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0" } })).id;
  };
  const bal = async (variantId: string, branchId = handle.branchId) =>
    handle.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId, productVariantId: variantId } } });
  const movement = async (variantId: string, type: string, ref: string) =>
    handle.prisma.inventoryMovement.findFirst({ where: { productVariantId: variantId, movementType: type as never, referenceType: ref }, orderBy: { createdAt: "desc" } });

  const purchase = async (variantId: string, boards: string, unitPrice: string, dims?: { lengthM?: string; widthM?: string }) => {
    const d = await request(server()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-07-15", supplierId, branchId: handle.branchId,
      lines: [{ productVariantId: variantId, boardsQuantity: boards, unitPrice, taxRate: "0", ...(dims ?? {}) }],
    });
    expect(d.status).toBeLessThan(300);
    await request(server()).post(`/api/v1/purchase-invoices/${d.body.id}/confirm`).set(auth()).send({});
    return d.body;
  };
  const sale = async (variantId: string, boards: string, unitPrice: string, dims?: { lengthM?: string; widthM?: string }) => {
    const d = await request(server()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-07-15", customerId, branchId: handle.branchId, taxRate: "0",
      lines: [{ productVariantId: variantId, quantity: boards, unitPrice, costPrice: "0", ...(dims ?? {}) }],
    });
    expect(d.status).toBeLessThan(300);
    const c = await request(server()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({});
    expect(c.status).toBeLessThan(300);
    return d.body;
  };

  it("1) LARGE: 2 boards × 5.25 → 10.50 meters (line + inventory movement)", async () => {
    const v = await freshVariant("1.0000");
    const inv = await purchase(v, "2", "100", { lengthM: "5.25" });
    expect(D(inv.lines[0].metersQuantity).toFixed(4)).toBe("10.5000");
    const mv = await movement(v, "RECEIPT", "purchase_invoice");
    expect(D(mv!.metersQuantity).toFixed(4)).toBe("10.5000");
    expect(D((await bal(v))!.metersOnHand).toFixed(4)).toBe("10.5000");
    expect(D((await bal(v))!.boardsOnHand).toFixed(4)).toBe("2.0000");
  });

  it("2) SMALL: 3 boards × 4.00 → 12.00 meters", async () => {
    const v = await freshVariant("1.0000");
    const inv = await purchase(v, "3", "100", { lengthM: "4.00" });
    expect(D(inv.lines[0].metersQuantity).toFixed(4)).toBe("12.0000");
    expect(D((await movement(v, "RECEIPT", "purchase_invoice"))!.metersQuantity).toFixed(4)).toBe("12.0000");
    expect(D((await bal(v))!.metersOnHand).toFixed(4)).toBe("12.0000");
  });

  it("3) CUSTOM: 2 boards × (2.00×1.50=3.00) → 6.00 meters — inventory is 6.00, NOT 8.00/10.50", async () => {
    const v = await freshVariant("4.0000"); // variant size 4 would wrongly give 8.00
    const inv = await purchase(v, "2", "100", { lengthM: "2.00", widthM: "1.50" });
    expect(D(inv.lines[0].metersQuantity).toFixed(4)).toBe("6.0000");            // financial meters
    expect(D(inv.lines[0].lineTotal).toFixed(2)).toBe("600.00");                 // 6 × 100
    const mv = await movement(v, "RECEIPT", "purchase_invoice");
    expect(D(mv!.metersQuantity).toFixed(4)).toBe("6.0000");       // inventory meters == financial
    expect(D((await bal(v))!.metersOnHand).toFixed(4)).toBe("6.0000");
    expect(D((await bal(v))!.boardsOnHand).toFixed(4)).toBe("2.0000");
  });

  it("4/5) SALES custom decreases the exact boards + meters that were sold", async () => {
    const v = await freshVariant("4.0000");
    await purchase(v, "5", "100", { lengthM: "3.00", widthM: "1.00" }); // 5 × 3 = 15 m, 5 boards
    expect(D((await bal(v))!.metersOnHand).toFixed(4)).toBe("15.0000");
    const inv = await sale(v, "2", "500", { lengthM: "2.00", widthM: "1.50" }); // 2 × 3 = 6 m
    expect(inv.lines[0].metersQuantity).toBe("6.0000");
    expect(inv.lines[0].lineTotal).toBe("3000.00"); // 6 × 500
    const mv = await movement(v, "SALE", "sales_invoice");
    expect(D(mv!.metersQuantity).toFixed(4)).toBe("-6.0000");
    expect(D((await bal(v))!.boardsOnHand).toFixed(4)).toBe("3.0000"); // 5 - 2
    expect(D((await bal(v))!.metersOnHand).toFixed(4)).toBe("9.0000"); // 15 - 6
  });

  it("6) other branch stays at zero (branch isolation)", async () => {
    const v = await freshVariant("4.0000");
    await purchase(v, "2", "100", { lengthM: "2.00", widthM: "1.50" });
    expect(await bal(v, otherBranchId)).toBeNull(); // no row for the untouched branch
  });

  it("7) DEFAULT (no dims) uses the variant size — no regression", async () => {
    const v = await freshVariant("5.2500");
    const inv = await purchase(v, "4", "100"); // no dims → 4 × 5.25 = 21.00
    expect(D(inv.lines[0].metersQuantity).toFixed(4)).toBe("21.0000");
    expect(D((await bal(v))!.metersOnHand).toFixed(4)).toBe("21.0000");
  });

  it("8) cancellation restores the EXACT custom meters that were posted", async () => {
    const v = await freshVariant("4.0000");
    const inv = await purchase(v, "3", "100", { lengthM: "2.00", widthM: "1.50" }); // 3 × 3 = 9 m
    expect(D((await bal(v))!.metersOnHand).toFixed(4)).toBe("9.0000");
    const c = await request(server()).post(`/api/v1/purchase-invoices/${inv.id}/cancel`).set(auth()).send({});
    expect(c.status).toBeLessThan(300);
    expect(D((await bal(v))!.boardsOnHand).toFixed(4)).toBe("0.0000");
    expect(D((await bal(v))!.metersOnHand).toFixed(4)).toBe("0.0000"); // restored exactly, not 12
  });

  it("9) editing the variant size does NOT change historical posted line/movement meters", async () => {
    const v = await freshVariant("4.0000");
    const inv = await purchase(v, "2", "100", { lengthM: "2.00", widthM: "1.50" }); // 6 m
    const lineMetersBefore = D(inv.lines[0].metersQuantity).toFixed(4);
    const mvBefore = D((await movement(v, "RECEIPT", "purchase_invoice"))!.metersQuantity).toFixed(4);
    // Now change the variant's stored size.
    await handle.prisma.productVariant.update({ where: { id: v }, data: { sizeMetersPerBoard: "9.9999" } });
    const line = await handle.prisma.salesInvoiceLine.findFirst({ where: {} }); void line;
    const pl = await handle.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: inv.id } });
    expect(D(pl!.metersQuantity).toFixed(4)).toBe(lineMetersBefore);            // line frozen
    expect(D((await movement(v, "RECEIPT", "purchase_invoice"))!.metersQuantity).toFixed(4)).toBe(mvBefore); // movement frozen
  });
});
