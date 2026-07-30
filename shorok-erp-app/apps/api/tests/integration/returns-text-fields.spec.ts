/**
 * Return free-text fields (§2/§3): header reason/notes and per-line reason/note
 * round-trip through create → update → read for BOTH return types, and can be
 * deliberately CLEARED. Explicit update semantics:
 *   omitted property        → preserve the stored value
 *   empty / whitespace      → stored as NULL
 *   non-empty               → stored trimmed
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("return text fields (§2/§3)", () => {
  let h: TestApp;
  let token: string;
  let customerId: string, supplierId: string, repId: string;
  let saleId: string, saleLineId: string, purchaseId: string, purchaseLineId: string;
  const acc: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const srv = () => h.app.getHttpServer();

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    repId = (await h.prisma.salesRepresentative.create({ data: { code: "TXR", nameAr: "م" } })).id;
    customerId = (await h.prisma.customer.create({ data: { code: "TXC", nameAr: "ع" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;
    const u = Date.now().toString().slice(-6);
    const mk = async (k: string, code: string, cat: any, t: any, role?: string) => {
      acc[k] = (await h.prisma.account.create({ data: { code: `${code}${u}`, nameAr: code, nameEn: code, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } })).id;
    };
    await mk("ar", "AR", "ASSET", "CURRENT_ASSET", "AR_CONTROL"); await mk("ap", "AP", "LIABILITY", "LIABILITY", "AP_CONTROL");
    await mk("rev", "RV", "REVENUE", "REVENUE"); await mk("sret", "SR", "REVENUE", "REVENUE");
    await mk("vatO", "VO", "LIABILITY", "LIABILITY"); await mk("vatI", "VI", "ASSET", "CURRENT_ASSET");
    await mk("cogs", "CG", "COST_OF_SALES", "COST_OF_SALES"); await mk("inv", "IN", "ASSET", "CURRENT_ASSET");
    await h.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev, salesReturnsAccountId: acc.sret, vatOutputAccountId: acc.vatO, vatInputAccountId: acc.vatI, cogsAccountId: acc.cogs, inventoryAccountId: acc.inv, createdBy: h.ownerId } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });

    const sku = await h.prisma.productSku.create({ data: { code: "TX-1", category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    const v = (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({ invoiceDate: "2026-02-01", supplierId, branchId: h.branchId, lines: [{ productVariantId: v, boardsQuantity: "20", unitPrice: "300", taxRate: "0" }] });
    await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(auth()).send({});
    purchaseId = p.body.id;
    purchaseLineId = (await h.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: purchaseId } }))!.id;
    const s = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({ invoiceDate: "2026-03-01", customerId, branchId: h.branchId, taxRate: "0", salesRepresentativeId: repId, lines: [{ productVariantId: v, quantity: "10", unitPrice: "500", costPrice: "0" }] });
    await request(srv()).post(`/api/v1/sales-invoices/${s.body.id}/confirm`).set(auth()).send({});
    saleId = s.body.id;
    saleLineId = (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: saleId } }))!.id;
  });
  afterAll(async () => teardownTestApp(h));

  const getSale = async (id: string) => (await request(srv()).get(`/api/v1/sales-returns/${id}`).set(auth())).body;
  const getPurchase = async (id: string) => (await request(srv()).get(`/api/v1/purchase-returns/${id}`).set(auth())).body;

  it("SALES: create → update → read preserves header reason/notes and line reason/note (trimmed)", async () => {
    const created = await request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: saleId, returnDate: "2026-03-10", reason: "  سبب أولي  ", notes: "  ملاحظات أولية  ",
      lines: [{ originalSalesInvoiceLineId: saleLineId, returnedMeters: "4", returnedBoards: "1", reason: "  سبب السطر  ", note: "  ملاحظة السطر  " }],
    });
    expect(created.status).toBeLessThan(300);
    let row = await getSale(created.body.id);
    // Stored TRIMMED on create.
    expect(row.reason).toBe("سبب أولي");
    expect(row.notes).toBe("ملاحظات أولية");
    expect(row.lines[0].reason).toBe("سبب السطر");
    expect(row.lines[0].note).toBe("ملاحظة السطر");

    // Update all four to new values.
    const upd = await request(srv()).put(`/api/v1/sales-returns/${created.body.id}`).set(auth()).send({
      reason: "سبب محدث", notes: "ملاحظات محدثة",
      lines: [{ originalSalesInvoiceLineId: saleLineId, returnedMeters: "4", returnedBoards: "1", reason: "سبب سطر محدث", note: "ملاحظة سطر محدثة" }],
    });
    expect(upd.status).toBeLessThan(300);
    row = await getSale(created.body.id);
    expect(row.reason).toBe("سبب محدث");
    expect(row.notes).toBe("ملاحظات محدثة");
    expect(row.lines[0].reason).toBe("سبب سطر محدث");
    expect(row.lines[0].note).toBe("ملاحظة سطر محدثة");

    // OMITTING the header text properties PRESERVES them.
    await request(srv()).put(`/api/v1/sales-returns/${created.body.id}`).set(auth()).send({
      lines: [{ originalSalesInvoiceLineId: saleLineId, returnedMeters: "4", returnedBoards: "1", reason: "سبب سطر محدث", note: "ملاحظة سطر محدثة" }],
    });
    row = await getSale(created.body.id);
    expect(row.reason).toBe("سبب محدث");
    expect(row.notes).toBe("ملاحظات محدثة");
  });

  it("SALES: empty/whitespace CLEARS header reason/notes and line reason/note to null", async () => {
    const created = await request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: saleId, returnDate: "2026-03-11", reason: "سبب", notes: "ملاحظات",
      lines: [{ originalSalesInvoiceLineId: saleLineId, returnedMeters: "4", returnedBoards: "1", reason: "سبب سطر", note: "ملاحظة سطر" }],
    });
    expect(created.status).toBeLessThan(300);
    const clear = await request(srv()).put(`/api/v1/sales-returns/${created.body.id}`).set(auth()).send({
      reason: "", notes: "   ",
      lines: [{ originalSalesInvoiceLineId: saleLineId, returnedMeters: "4", returnedBoards: "1", reason: "", note: "   " }],
    });
    expect(clear.status).toBeLessThan(300);
    const row = await getSale(created.body.id);
    expect(row.reason).toBeNull();
    expect(row.notes).toBeNull();
    expect(row.lines[0].reason).toBeNull();
    expect(row.lines[0].note).toBeNull();
  });

  it("PURCHASE: create → update → read preserves all four, and omitting header text preserves it", async () => {
    const created = await request(srv()).post("/api/v1/purchase-returns").set(auth()).send({
      originalPurchaseInvoiceId: purchaseId, returnDate: "2026-03-12", reason: "  سبب شراء  ", notes: "  ملاحظات شراء  ",
      lines: [{ originalPurchaseInvoiceLineId: purchaseLineId, returnedMeters: "4", returnedBoards: "1", reason: "  سبب سطر شراء  ", note: "  ملاحظة سطر شراء  " }],
    });
    expect(created.status).toBeLessThan(300);
    let row = await getPurchase(created.body.id);
    expect(row.reason).toBe("سبب شراء");
    expect(row.notes).toBe("ملاحظات شراء");
    expect(row.lines[0].reason).toBe("سبب سطر شراء");
    expect(row.lines[0].note).toBe("ملاحظة سطر شراء");

    await request(srv()).put(`/api/v1/purchase-returns/${created.body.id}`).set(auth()).send({
      reason: "سبب شراء محدث", notes: "ملاحظات شراء محدثة",
      lines: [{ originalPurchaseInvoiceLineId: purchaseLineId, returnedMeters: "4", returnedBoards: "1", reason: "سبب سطر محدث", note: "ملاحظة سطر محدثة" }],
    });
    row = await getPurchase(created.body.id);
    expect(row.reason).toBe("سبب شراء محدث");
    expect(row.lines[0].reason).toBe("سبب سطر محدث");
    expect(row.lines[0].note).toBe("ملاحظة سطر محدثة");

    // Omit header AND line text → BOTH preserved (the delete/recreate must not
    // erase stored per-line text — §2).
    await request(srv()).put(`/api/v1/purchase-returns/${created.body.id}`).set(auth()).send({
      lines: [{ originalPurchaseInvoiceLineId: purchaseLineId, returnedMeters: "4", returnedBoards: "1" }],
    });
    row = await getPurchase(created.body.id);
    expect(row.reason).toBe("سبب شراء محدث");
    expect(row.notes).toBe("ملاحظات شراء محدثة");
    // Omitted line text is PRESERVED, not nulled.
    expect(row.lines[0].reason).toBe("سبب سطر محدث");
    expect(row.lines[0].note).toBe("ملاحظة سطر محدثة");
  });

  it("PURCHASE: empty/whitespace CLEARS all four to null", async () => {
    const created = await request(srv()).post("/api/v1/purchase-returns").set(auth()).send({
      originalPurchaseInvoiceId: purchaseId, returnDate: "2026-03-13", reason: "سبب", notes: "ملاحظات",
      lines: [{ originalPurchaseInvoiceLineId: purchaseLineId, returnedMeters: "4", returnedBoards: "1", reason: "سبب سطر", note: "ملاحظة سطر" }],
    });
    expect(created.status).toBeLessThan(300);
    const clear = await request(srv()).put(`/api/v1/purchase-returns/${created.body.id}`).set(auth()).send({
      reason: "  ", notes: "",
      lines: [{ originalPurchaseInvoiceLineId: purchaseLineId, returnedMeters: "4", returnedBoards: "1", reason: "  ", note: "" }],
    });
    expect(clear.status).toBeLessThan(300);
    const row = await getPurchase(created.body.id);
    expect(row.reason).toBeNull();
    expect(row.notes).toBeNull();
    expect(row.lines[0].reason).toBeNull();
    expect(row.lines[0].note).toBeNull();
  });

  // §2 — omitted per-line text must PRESERVE the stored value across the
  // delete-and-recreate that a draft update / confirm performs. Covers A-E for
  // both return types: (A) create with line reason+note, (B) update omitting
  // them → preserved, (C) empty/whitespace → NULL, (D) new values →
  // trimmed+separate, (E) a genuinely new line omitting text → NULL.
  it("SALES §2: omitted line reason/note preserved; empty clears; new trimmed & separate", async () => {
    // (A) create with line reason+note.
    const created = await request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: saleId, returnDate: "2026-03-15",
      lines: [{ originalSalesInvoiceLineId: saleLineId, returnedMeters: "4", returnedBoards: "1", reason: "  سبب باقٍ  ", note: "  ملاحظة باقية  " }],
    });
    expect(created.status).toBeLessThan(300);
    let row = await getSale(created.body.id);
    expect(row.lines[0].reason).toBe("سبب باقٍ");
    expect(row.lines[0].note).toBe("ملاحظة باقية");

    // (B) update the line WITHOUT reason/note keys → both preserved.
    await request(srv()).put(`/api/v1/sales-returns/${created.body.id}`).set(auth()).send({
      lines: [{ originalSalesInvoiceLineId: saleLineId, returnedMeters: "4", returnedBoards: "1" }],
    });
    row = await getSale(created.body.id);
    expect(row.lines[0].reason).toBe("سبب باقٍ");
    expect(row.lines[0].note).toBe("ملاحظة باقية");

    // Mixed: omit reason (preserve), clear note (whitespace → null).
    await request(srv()).put(`/api/v1/sales-returns/${created.body.id}`).set(auth()).send({
      lines: [{ originalSalesInvoiceLineId: saleLineId, returnedMeters: "4", returnedBoards: "1", note: "   " }],
    });
    row = await getSale(created.body.id);
    expect(row.lines[0].reason).toBe("سبب باقٍ");
    expect(row.lines[0].note).toBeNull();

    // (C) empty reason → null (note already null).
    await request(srv()).put(`/api/v1/sales-returns/${created.body.id}`).set(auth()).send({
      lines: [{ originalSalesInvoiceLineId: saleLineId, returnedMeters: "4", returnedBoards: "1", reason: "" }],
    });
    row = await getSale(created.body.id);
    expect(row.lines[0].reason).toBeNull();

    // (D) new values → trimmed + separate.
    await request(srv()).put(`/api/v1/sales-returns/${created.body.id}`).set(auth()).send({
      lines: [{ originalSalesInvoiceLineId: saleLineId, returnedMeters: "4", returnedBoards: "1", reason: "  سبب جديد  ", note: "  ملاحظة جديدة  " }],
    });
    row = await getSale(created.body.id);
    expect(row.lines[0].reason).toBe("سبب جديد");
    expect(row.lines[0].note).toBe("ملاحظة جديدة");
    expect(row.lines[0].reason).not.toBe(row.lines[0].note);
  });

  it("PURCHASE §2: omitted line reason/note preserved; empty clears; new trimmed & separate", async () => {
    // (A) create with line reason+note.
    const created = await request(srv()).post("/api/v1/purchase-returns").set(auth()).send({
      originalPurchaseInvoiceId: purchaseId, returnDate: "2026-03-16",
      lines: [{ originalPurchaseInvoiceLineId: purchaseLineId, returnedMeters: "4", returnedBoards: "1", reason: "  سبب باقٍ  ", note: "  ملاحظة باقية  " }],
    });
    expect(created.status).toBeLessThan(300);
    let row = await getPurchase(created.body.id);
    expect(row.lines[0].reason).toBe("سبب باقٍ");
    expect(row.lines[0].note).toBe("ملاحظة باقية");

    // (B) update WITHOUT reason/note → preserved.
    await request(srv()).put(`/api/v1/purchase-returns/${created.body.id}`).set(auth()).send({
      lines: [{ originalPurchaseInvoiceLineId: purchaseLineId, returnedMeters: "4", returnedBoards: "1" }],
    });
    row = await getPurchase(created.body.id);
    expect(row.lines[0].reason).toBe("سبب باقٍ");
    expect(row.lines[0].note).toBe("ملاحظة باقية");

    // Mixed: omit reason (preserve), clear note.
    await request(srv()).put(`/api/v1/purchase-returns/${created.body.id}`).set(auth()).send({
      lines: [{ originalPurchaseInvoiceLineId: purchaseLineId, returnedMeters: "4", returnedBoards: "1", note: "" }],
    });
    row = await getPurchase(created.body.id);
    expect(row.lines[0].reason).toBe("سبب باقٍ");
    expect(row.lines[0].note).toBeNull();

    // (C) empty reason → null.
    await request(srv()).put(`/api/v1/purchase-returns/${created.body.id}`).set(auth()).send({
      lines: [{ originalPurchaseInvoiceLineId: purchaseLineId, returnedMeters: "4", returnedBoards: "1", reason: "  " }],
    });
    row = await getPurchase(created.body.id);
    expect(row.lines[0].reason).toBeNull();

    // (D) new values → trimmed + separate.
    await request(srv()).put(`/api/v1/purchase-returns/${created.body.id}`).set(auth()).send({
      lines: [{ originalPurchaseInvoiceLineId: purchaseLineId, returnedMeters: "4", returnedBoards: "1", reason: "  سبب جديد  ", note: "  ملاحظة جديدة  " }],
    });
    row = await getPurchase(created.body.id);
    expect(row.lines[0].reason).toBe("سبب جديد");
    expect(row.lines[0].note).toBe("ملاحظة جديدة");
    expect(row.lines[0].reason).not.toBe(row.lines[0].note);
  });

  // (E) a genuinely NEW line that omits text stores null (no prior value to
  // preserve). Confirmed by the create paths above where omitted → null.
  it("SALES §2(E): a newly created line that omits reason/note stores null", async () => {
    const created = await request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: saleId, returnDate: "2026-03-17",
      lines: [{ originalSalesInvoiceLineId: saleLineId, returnedMeters: "4", returnedBoards: "1" }],
    });
    expect(created.status).toBeLessThan(300);
    const row = await getSale(created.body.id);
    expect(row.lines[0].reason).toBeNull();
    expect(row.lines[0].note).toBeNull();
  });

  it("PURCHASE §2(E): a newly created line that omits reason/note stores null", async () => {
    const created = await request(srv()).post("/api/v1/purchase-returns").set(auth()).send({
      originalPurchaseInvoiceId: purchaseId, returnDate: "2026-03-18",
      lines: [{ originalPurchaseInvoiceLineId: purchaseLineId, returnedMeters: "4", returnedBoards: "1" }],
    });
    expect(created.status).toBeLessThan(300);
    const row = await getPurchase(created.body.id);
    expect(row.lines[0].reason).toBeNull();
    expect(row.lines[0].note).toBeNull();
  });

  it("line reason and note stay SEPARATE fields (never merged) through confirm", async () => {
    const created = await request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: saleId, returnDate: "2026-03-14",
      lines: [{ originalSalesInvoiceLineId: saleLineId, returnedMeters: "4", returnedBoards: "1", reason: "سبب مستقل", note: "ملاحظة مستقلة" }],
    });
    expect((await request(srv()).post(`/api/v1/sales-returns/${created.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    const row = await getSale(created.body.id);
    expect(row.status).toBe("CONFIRMED");
    expect(row.lines[0].reason).toBe("سبب مستقل");
    expect(row.lines[0].note).toBe("ملاحظة مستقلة");
    expect(row.lines[0].reason).not.toBe(row.lines[0].note);
  });
});
