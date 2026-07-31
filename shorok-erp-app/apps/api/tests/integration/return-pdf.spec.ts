/**
 * Return PDF export — GET /sales-returns/:id/pdf and /purchase-returns/:id/pdf.
 * Proves a real downloadable PDF for DRAFT and CONFIRMED returns (application/pdf,
 * attachment filename with the return number + status, %PDF bytes), that the
 * download mutates nothing (no status/journal/stock change), and that auth +
 * branch no-leak are preserved. Renders via headless Chromium (CHROME_PATH).
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

jest.setTimeout(120000);
if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  process.env.CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

const binaryParser = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("return PDF export", () => {
  let h: TestApp;
  let ownerToken: string;
  let customerId: string, supplierId: string;
  const server = () => h.app.getHttpServer();
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  let seq = 0;
  const variant = async () => {
    seq += 1;
    const sku = await h.prisma.productSku.create({ data: { code: `RPDF-${seq}`, category: "NORMAL", colorNameAr: "أحمر", colorNameEn: "red" } });
    return (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "4", defaultSalePricePerMeter: "500", defaultPurchasePricePerMeter: "300", avgCost: "0", avgCostPerMeter: "0" } })).id;
  };
  const buy = async (v: string, boards = "10") => {
    const p = await request(server()).post("/api/v1/purchase-invoices").set(H(ownerToken)).send({
      invoiceDate: "2026-07-01", supplierId, branchId: h.branchId,
      lines: [{ productVariantId: v, boardsQuantity: boards, unitPrice: "300", taxRate: "14" }],
    });
    expect((await request(server()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(H(ownerToken)).send({})).status).toBeLessThan(300);
    return p.body.id as string;
  };
  const sell = async (v: string) => {
    const d = await request(server()).post("/api/v1/sales-invoices").set(H(ownerToken)).send({
      invoiceDate: "2026-07-05", customerId, branchId: h.branchId, taxRate: "14",
      lines: [{ productVariantId: v, quantity: "3", unitPrice: "500", costPrice: "0" }],
    });
    expect((await request(server()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(H(ownerToken)).send({})).status).toBeLessThan(300);
    return d.body.id as string;
  };
  const saleReturn = async (confirmIt: boolean) => {
    const v = await variant();
    await buy(v);
    const inv = await sell(v);
    const line = (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: inv } }))!.id;
    const draft = (await request(server()).post("/api/v1/sales-returns").set(H(ownerToken)).send({
      originalSalesInvoiceId: inv, returnDate: "2026-07-15", lines: [{ originalSalesInvoiceLineId: line, returnedBoards: "1" }],
    })).body;
    if (confirmIt) expect((await request(server()).post(`/api/v1/sales-returns/${draft.id}/confirm`).set(H(ownerToken)).send({})).status).toBeLessThan(300);
    return draft.id as string;
  };
  const purchaseReturn = async (confirmIt: boolean) => {
    const v = await variant();
    const pid = await buy(v);
    const line = (await h.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: pid } }))!.id;
    const draft = (await request(server()).post("/api/v1/purchase-returns").set(H(ownerToken)).send({
      originalPurchaseInvoiceId: pid, returnDate: "2026-07-15", lines: [{ originalPurchaseInvoiceLineId: line, returnedBoards: "1" }],
    })).body;
    if (confirmIt) expect((await request(server()).post(`/api/v1/purchase-returns/${draft.id}/confirm`).set(H(ownerToken)).send({})).status).toBeLessThan(300);
    return draft.id as string;
  };

  const getPdf = (path: string, token = ownerToken) =>
    request(server()).get(path).set(H(token)).buffer(true).parse(binaryParser as any);
  const assertPdf = (res: any, filenamePart: string) => {
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(filenamePart);
    expect(res.headers["cache-control"]).toContain("no-store");
    const body: Buffer = res.body;
    expect(body.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(body.length).toBeGreaterThan(3000);
  };
  const snapshot = async () => ({
    je: await h.prisma.journalEntry.count(),
    mv: await h.prisma.inventoryMovement.count(),
    srl: await h.prisma.salesReturnLine.count(),
    prl: await h.prisma.purchaseReturnLine.count(),
  });

  beforeAll(async () => {
    h = await buildTestApp();
    const pw = "Pwd@2026!";
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash(pw, 10) } });
    ownerToken = (await request(server()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: pw })).body.accessToken;
    const u = Date.now().toString().slice(-6);
    customerId = (await h.prisma.customer.create({ data: { code: `C-${u}`, nameAr: "محمد الجردقه" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "ميجا بوند", nameEn: "Mega Bond" } })).id;
    const acc = (code: string, nameAr: string, cat: string, t: string, role?: string) =>
      h.prisma.account.create({ data: { code, nameAr, nameEn: nameAr, category: cat as never, accountType: t as never, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } });
    const ar = (await acc(`AR${u}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    const ap = (await acc(`AP${u}`, "موردون", "LIABILITY", "LIABILITY", "AP_CONTROL")).id;
    const rev = (await acc(`REV${u}`, "مبيعات", "REVENUE", "REVENUE")).id;
    const sret = (await acc(`SRET${u}`, "مردودات المبيعات", "REVENUE", "REVENUE")).id;
    const vatOut = (await acc(`VO${u}`, "ض مبيعات", "LIABILITY", "LIABILITY")).id;
    const vatIn = (await acc(`VI${u}`, "ض مشتريات", "ASSET", "CURRENT_ASSET")).id;
    const cogs = (await acc(`CG${u}`, "تكلفة", "COST_OF_SALES", "COST_OF_SALES")).id;
    const inv = (await acc(`IN${u}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;
    await h.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: ar, apAccountId: ap, revenueAccountId: rev, salesReturnsAccountId: sret, vatOutputAccountId: vatOut, vatInputAccountId: vatIn, cogsAccountId: cogs, inventoryAccountId: inv, createdBy: h.ownerId } });
    await h.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });
  afterAll(async () => teardownTestApp(h));

  it("DRAFT sales return → PDF, draft filename, no mutation, still DRAFT", async () => {
    const id = await saleReturn(false);
    const before = await snapshot();
    const res = await getPdf(`/api/v1/sales-returns/${id}/pdf`);
    assertPdf(res, "-draft.pdf");
    expect(res.headers["content-disposition"]).toMatch(/filename="sales-return-SR-\d+-draft\.pdf"/);
    expect((await h.prisma.salesReturn.findUnique({ where: { id } }))!.status).toBe("DRAFT");
    expect(await snapshot()).toEqual(before);
  });

  it("CONFIRMED sales return → PDF with confirmed filename (ar + en)", async () => {
    const id = await saleReturn(true);
    assertPdf(await getPdf(`/api/v1/sales-returns/${id}/pdf?locale=ar`), "-confirmed.pdf");
    assertPdf(await getPdf(`/api/v1/sales-returns/${id}/pdf?locale=en`), "-confirmed.pdf");
  });

  it("DRAFT purchase return → PDF, no mutation, still DRAFT", async () => {
    const id = await purchaseReturn(false);
    const before = await snapshot();
    const res = await getPdf(`/api/v1/purchase-returns/${id}/pdf`);
    assertPdf(res, "-draft.pdf");
    expect(res.headers["content-disposition"]).toMatch(/filename="purchase-return-PR-\d+-draft\.pdf"/);
    expect((await h.prisma.purchaseReturn.findUnique({ where: { id } }))!.status).toBe("DRAFT");
    expect(await snapshot()).toEqual(before);
  });

  it("CONFIRMED purchase return → PDF", async () => {
    assertPdf(await getPdf(`/api/v1/purchase-returns/${await purchaseReturn(true)}/pdf`), "-confirmed.pdf");
  });

  it("repeated downloads are idempotent (no DB changes)", async () => {
    const id = await saleReturn(true);
    const before = await snapshot();
    for (let i = 0; i < 3; i++) assertPdf(await getPdf(`/api/v1/sales-returns/${id}/pdf`), ".pdf");
    expect(await snapshot()).toEqual(before);
  });

  it("unknown id → 404, unauthenticated → 401, forbidden role → 403", async () => {
    const id = await saleReturn(false);
    expect((await getPdf(`/api/v1/sales-returns/00000000-0000-0000-0000-000000000000/pdf`)).status).toBe(404);
    expect((await request(server()).get(`/api/v1/sales-returns/${id}/pdf`)).status).toBe(401);
    await h.prisma.user.create({ data: { name: "V", phone: "+201509090955", passwordHash: await bcrypt.hash("Pwd@2026!", 10), role: "VIEWER", status: "ACTIVE" } });
    const vToken = (await request(server()).post("/api/v1/auth/login").send({ phone: "+201509090955", password: "Pwd@2026!" })).body.accessToken;
    expect((await request(server()).get(`/api/v1/sales-returns/${id}/pdf`).set(H(vToken))).status).toBe(403);
  });

  it("a branch-restricted user cannot download a foreign-branch return (404, no leak)", async () => {
    const id = await saleReturn(false); // in h.branchId
    const s = Date.now().toString().slice(-5);
    const otherBranch = (await h.prisma.branch.create({ data: { nameAr: `فرع آخر ${s}`, nameEn: `Other ${s}` } })).id;
    await h.prisma.user.create({ data: { name: "M", phone: "+201509090944", passwordHash: await bcrypt.hash("Pwd@2026!", 10), role: "BRANCH_MANAGER", status: "ACTIVE", branchAccesses: { create: { branchId: otherBranch } } } });
    const mToken = (await request(server()).post("/api/v1/auth/login").send({ phone: "+201509090944", password: "Pwd@2026!" })).body.accessToken;
    const res = await request(server()).get(`/api/v1/sales-returns/${id}/pdf`).set(H(mToken));
    expect(res.status).toBe(404); // not 403 → no existence leak
  });
});
