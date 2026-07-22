/**
 * Invoice PDF export — GET /sales-invoices/:id/pdf and /purchase-invoices/:id/pdf.
 * Verifies a real downloadable PDF (application/pdf, attachment filename, %PDF
 * magic bytes, non-trivial size), auth enforcement, 404 for unknown, and that a
 * DRAFT invoice still exports (watermark path). Renders via headless Chromium;
 * CHROME_PATH points at a local Chromium/Chrome build.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

// Chromium launch + render is well over jest's default 5s.
jest.setTimeout(120000);

// Use a local Chrome/Chromium for rendering when the runner didn't set one.
if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  process.env.CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

// Collect the raw response body as a Buffer (supertest won't parse application/pdf).
const binaryParser = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("invoice PDF export", () => {
  let handle: TestApp;
  let ownerToken: string;
  let customerId: string, supplierId: string;

  const server = () => handle.app.getHttpServer();
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  let seq = 0;
  const freshVariant = async (stockBoards = "0") => {
    seq += 1;
    const sku = await handle.prisma.productSku.create({ data: { code: `PDF-${seq}`, category: "NORMAL", colorNameAr: "أصفر لامع", colorNameEn: "yellow" } });
    const v = await handle.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "5.25", defaultSalePricePerMeter: "525", defaultPurchasePricePerMeter: "300", avgCost: "300" } });
    if (Number(stockBoards) > 0) {
      // Seed CONSISTENT stock: meters = boards × size (5.25), matching the
      // engine's meter accounting.
      const meters = (Number(stockBoards) * 5.25).toFixed(4);
      await handle.prisma.branchInventoryBalance.create({ data: { branchId: handle.branchId, productVariantId: v.id, boardsOnHand: stockBoards, metersOnHand: meters } });
    }
    return v.id;
  };

  const createSalesDraft = async () => {
    const variantId = await freshVariant("20");
    const res = await request(server()).post("/api/v1/sales-invoices").set(H(ownerToken)).send({
      invoiceDate: "2026-07-15", customerId, branchId: handle.branchId, taxRate: "14",
      lines: [{ productVariantId: variantId, quantity: "4", unitPrice: "525.00", costPrice: "300.00" }],
    });
    expect(res.status).toBeLessThan(300);
    return res.body.id as string;
  };

  const confirmSales = async (id: string) => {
    const c = await request(server()).post(`/api/v1/sales-invoices/${id}/confirm`).set(H(ownerToken)).send({});
    expect(c.status).toBeLessThan(300);
  };

  const createPurchase = async () => {
    const variantId = await freshVariant();
    const res = await request(server()).post("/api/v1/purchase-invoices").set(H(ownerToken)).send({
      invoiceDate: "2026-07-15", supplierId, branchId: handle.branchId,
      lines: [{ productVariantId: variantId, boardsQuantity: "4", lengthM: "5.25", unitPrice: "300.00", taxRate: "14" }],
    });
    expect(res.status).toBeLessThan(300);
    const c = await request(server()).post(`/api/v1/purchase-invoices/${res.body.id}/confirm`).set(H(ownerToken)).send({});
    expect(c.status).toBeLessThan(300);
    return res.body.id as string;
  };

  const getPdf = (path: string, token = ownerToken) =>
    request(server()).get(path).set(H(token)).buffer(true).parse(binaryParser as any);

  const assertPdf = (res: any, expectedFilenamePart: string) => {
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(expectedFilenamePart);
    const body: Buffer = res.body;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(body.length).toBeGreaterThan(3000);
  };

  beforeAll(async () => {
    handle = await buildTestApp();
    const pw = "Pwd@2026!";
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash: await bcrypt.hash(pw, 10) } });
    ownerToken = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: pw })).body.accessToken;

    const u = Date.now().toString().slice(-6);
    customerId = (await handle.prisma.customer.create({ data: { code: `C-PDF-${u}`, nameAr: "أحمد محمد علي", phone: "01000000001" } })).id;
    supplierId = (await handle.prisma.supplier.create({ data: { nameAr: `مورد اختبار PDF ${u}`, nameEn: `Test Supplier PDF ${u}` } })).id;

    const acc = (code: string, nameAr: string, cat: string, t: string, role?: string) =>
      handle.prisma.account.create({ data: { code, nameAr, nameEn: nameAr, category: cat as never, accountType: t as never, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } });
    const ar = (await acc(`AR${u}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    const ap = (await acc(`AP${u}`, "موردون", "LIABILITY", "LIABILITY", "AP_CONTROL")).id;
    const rev = (await acc(`REV${u}`, "مبيعات", "REVENUE", "REVENUE")).id;
    const vatOut = (await acc(`VO${u}`, "ضريبة مبيعات", "LIABILITY", "LIABILITY")).id;
    const vatIn = (await acc(`VI${u}`, "ضريبة مشتريات", "ASSET", "CURRENT_ASSET")).id;
    const cogs = (await acc(`CG${u}`, "تكلفة مبيعات", "COST_OF_SALES", "COST_OF_SALES")).id;
    const inv = (await acc(`IN${u}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: ar, apAccountId: ap, revenueAccountId: rev, vatOutputAccountId: vatOut, vatInputAccountId: vatIn, cogsAccountId: cogs, inventoryAccountId: inv, createdBy: handle.ownerId } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
    // No companyProfile row: the mapper falls back to a default company name, so
    // the PDF endpoints don't depend on it existing.
  });

  afterAll(async () => teardownTestApp(handle));

  it("confirmed sales invoice → downloadable application/pdf with %PDF bytes", async () => {
    const id = await createSalesDraft();
    await confirmSales(id);
    const res = await getPdf(`/api/v1/sales-invoices/${id}/pdf`);
    assertPdf(res, ".pdf");
  });

  it("draft sales invoice still exports (watermark path)", async () => {
    const id = await createSalesDraft(); // not confirmed → DRAFT
    const res = await getPdf(`/api/v1/sales-invoices/${id}/pdf`);
    assertPdf(res, ".pdf");
  });

  it("sales PDF filename is sales-invoice-SI-{number}.pdf and export mutates nothing", async () => {
    const id = await createSalesDraft();
    await confirmSales(id);
    const snap = async () => ({
      status: (await handle.prisma.salesInvoice.findUnique({ where: { id } }))!.status,
      je: await handle.prisma.journalEntry.count(),
      mv: await handle.prisma.inventoryMovement.count(),
      lines: await handle.prisma.salesInvoiceLine.count(),
    });
    const before = await snap();
    const res = await getPdf(`/api/v1/sales-invoices/${id}/pdf`);
    assertPdf(res, "sales-invoice-SI-");
    expect(res.headers["content-disposition"]).toMatch(/filename="sales-invoice-SI-\d+\.pdf"/);
    expect(await snap()).toEqual(before); // read-only export: nothing changed
  });

  it("rejects a non-authorized role (VIEWER → 403), no PDF", async () => {
    const id = await createSalesDraft();
    await handle.prisma.user.create({ data: { name: "V", phone: "+201509090909", passwordHash: await bcrypt.hash("Pwd@2026!", 10), role: "VIEWER", status: "ACTIVE" } });
    const vToken = (await request(server()).post("/api/v1/auth/login").send({ phone: "+201509090909", password: "Pwd@2026!" })).body.accessToken;
    const res = await request(server()).get(`/api/v1/sales-invoices/${id}/pdf`).set(H(vToken));
    expect(res.status).toBe(403);
  });

  it("confirmed purchase invoice → downloadable application/pdf", async () => {
    const id = await createPurchase();
    const res = await getPdf(`/api/v1/purchase-invoices/${id}/pdf`);
    assertPdf(res, ".pdf");
  });

  it("rejects unauthenticated requests (401), no PDF", async () => {
    const id = await createSalesDraft();
    const res = await request(server()).get(`/api/v1/sales-invoices/${id}/pdf`);
    expect(res.status).toBe(401);
  });

  it("unknown sales invoice id → 404", async () => {
    const res = await getPdf(`/api/v1/sales-invoices/00000000-0000-0000-0000-000000000000/pdf`);
    expect(res.status).toBe(404);
  });

  it("unknown purchase invoice id → 404", async () => {
    const res = await getPdf(`/api/v1/purchase-invoices/00000000-0000-0000-0000-000000000000/pdf`);
    expect(res.status).toBe(404);
  });
});
