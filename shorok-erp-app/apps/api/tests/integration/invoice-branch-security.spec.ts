/**
 * Direct API branch scope for the INVOICE-by-id endpoints (§3/§4).
 *
 * The global BranchScopeGuard only inspects an explicit `branchId` in
 * params/query/body, so it is a no-op for routes addressed by the invoice
 * `:id`. Each such endpoint must therefore enforce the branch itself:
 *
 *   Sales   GET /:id, GET /:id/pdf, PUT /:id, POST /:id/confirm   (ACCOUNTANT-reachable)
 *   Purchase GET /:id, GET /:id/pdf                               (ACCOUNTANT-reachable)
 *
 * Policy (identical to the returns endpoints):
 *   - OWNER reads/acts across all branches.
 *   - A non-OWNER outside allowedBranches gets 404 — never 403 — so a foreign
 *     invoice is indistinguishable from a non-existent one (no existence leak).
 *   - The forbidden response body carries NO invoice content.
 *
 * cancel/delete (both types) and purchase confirm are OWNER-only, so a
 * non-OWNER never reaches them (RolesGuard 403); OWNER legitimately spans all
 * branches, so there is nothing to scope there.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("invoice-by-id branch security (§3/§4)", () => {
  let h: TestApp;
  let owner: string, userA: string, userB: string;
  let branchA: string, branchB: string;
  let repId: string, customerId: string, supplierId: string;
  const acc: Record<string, string> = {};
  const A = (t: string) => ({ Authorization: `Bearer ${t}` });
  const srv = () => h.app.getHttpServer();
  const login = async (phone: string) => (await request(srv()).post("/api/v1/auth/login").send({ phone, password: "Pwd@2026!" })).body.accessToken as string;

  const FAKE = "00000000-0000-0000-0000-000000000000";
  // Confirmed sale & purchase in branch A, plus two DRAFT sales in branch A for
  // the PUT / confirm scope tests.
  let saleA: string, draftForUpdate: string, draftForConfirm: string;
  let purchaseA: string;

  beforeAll(async () => {
    h = await buildTestApp();
    branchA = h.branchId;
    branchB = (await h.prisma.branch.create({ data: { nameAr: "ب", nameEn: "B", active: true } })).id;
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    owner = await login(h.ownerPhone);
    const mkUser = async (phone: string, branches: string[]) => {
      const u = await h.prisma.user.create({ data: { name: phone, phone, passwordHash: await bcrypt.hash("Pwd@2026!", 10), role: "ACCOUNTANT", status: "ACTIVE" } });
      for (const b of branches) await h.prisma.userBranchAccess.create({ data: { userId: u.id, branchId: b } });
      return login(phone);
    };
    userA = await mkUser("+201110000011", [branchA]);
    userB = await mkUser("+201110000012", [branchB]);
    repId = (await h.prisma.salesRepresentative.create({ data: { code: "IBR", nameAr: "م" } })).id;
    customerId = (await h.prisma.customer.create({ data: { code: "IBC", nameAr: "عميل سري", phone: "0100" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد سري", nameEn: "Secret Supplier" } })).id;
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

    const sku = await h.prisma.productSku.create({ data: { code: "IB-1", category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    const v = (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;

    // Confirmed PURCHASE in branch A (also stocks the variant for the sale).
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(A(owner)).send({ invoiceDate: "2026-02-01", supplierId, branchId: branchA, lines: [{ productVariantId: v, boardsQuantity: "20", unitPrice: "300", taxRate: "0" }] });
    await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(A(owner)).send({});
    purchaseA = p.body.id;

    // Confirmed SALE in branch A.
    const s = await request(srv()).post("/api/v1/sales-invoices").set(A(owner)).send({ invoiceDate: "2026-03-01", customerId, branchId: branchA, taxRate: "0", salesRepresentativeId: repId, lines: [{ productVariantId: v, quantity: "5", unitPrice: "500", costPrice: "0" }] });
    await request(srv()).post(`/api/v1/sales-invoices/${s.body.id}/confirm`).set(A(owner)).send({});
    saleA = s.body.id;

    // Two DRAFT sales in branch A: one for the PUT test, one for the confirm test.
    const mkDraft = async () => (await request(srv()).post("/api/v1/sales-invoices").set(A(owner)).send({ invoiceDate: "2026-03-02", customerId, branchId: branchA, taxRate: "0", salesRepresentativeId: repId, lines: [{ productVariantId: v, quantity: "1", unitPrice: "500", costPrice: "0" }] })).body.id;
    draftForUpdate = await mkDraft();
    draftForConfirm = await mkDraft();
  });
  afterAll(async () => teardownTestApp(h));

  // A forbidden reply must carry NO invoice content: it is exactly the generic
  // not_found error, whose only datum is the id the caller itself supplied
  // (never the party names, totals, lines, or a PDF body). Asserting the whole
  // shape is stronger — and avoids false positives from a short invoice number
  // that happens to be a substring of the echoed UUID.
  const carriesNoInvoiceContent = (res: request.Response, requestedId: string) => {
    const blob = `${res.text ?? ""}${JSON.stringify(res.body ?? {})}`;
    for (const n of ["عميل سري", "مورد سري", "Secret Supplier"]) expect(blob).not.toContain(n);
    expect(blob).not.toContain("%PDF");
    expect(res.body.code).toBe("not_found");
    // details echoes ONLY the requested id — nothing derived from the invoice.
    expect(res.body.details).toEqual({ id: requestedId });
  };

  it("SALES GET /:id — userB 404, userA 200, owner 200; foreign == non-existent (no leak)", async () => {
    const foreign = await request(srv()).get(`/api/v1/sales-invoices/${saleA}`).set(A(userB));
    const missing = await request(srv()).get(`/api/v1/sales-invoices/${FAKE}`).set(A(userB));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    // Same observable status AND shape → forbidden is indistinguishable from absent.
    expect(Object.keys(foreign.body).sort()).toEqual(Object.keys(missing.body).sort());
    carriesNoInvoiceContent(foreign, saleA);
    expect((await request(srv()).get(`/api/v1/sales-invoices/${saleA}`).set(A(userA))).status).toBe(200);
    expect((await request(srv()).get(`/api/v1/sales-invoices/${saleA}`).set(A(owner))).status).toBe(200);
  });

  it("PURCHASE GET /:id — userB 404, userA 200, owner 200; foreign == non-existent (no leak)", async () => {
    const foreign = await request(srv()).get(`/api/v1/purchase-invoices/${purchaseA}`).set(A(userB));
    const missing = await request(srv()).get(`/api/v1/purchase-invoices/${FAKE}`).set(A(userB));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(Object.keys(foreign.body).sort()).toEqual(Object.keys(missing.body).sort());
    carriesNoInvoiceContent(foreign, purchaseA);
    expect((await request(srv()).get(`/api/v1/purchase-invoices/${purchaseA}`).set(A(userA))).status).toBe(200);
    expect((await request(srv()).get(`/api/v1/purchase-invoices/${purchaseA}`).set(A(owner))).status).toBe(200);
  });

  it("SALES GET /:id/pdf — userB 404 with NO file content; userA + owner get a PDF", async () => {
    const foreign = await request(srv()).get(`/api/v1/sales-invoices/${saleA}/pdf`).set(A(userB));
    expect(foreign.status).toBe(404);
    carriesNoInvoiceContent(foreign, saleA);
    const missing = await request(srv()).get(`/api/v1/sales-invoices/${FAKE}/pdf`).set(A(userB));
    expect(missing.status).toBe(404);
    for (const t of [userA, owner]) {
      const ok = await request(srv()).get(`/api/v1/sales-invoices/${saleA}/pdf`).set(A(t)).buffer(true);
      expect(ok.status).toBe(200);
      expect(ok.headers["content-type"]).toContain("pdf");
    }
  });

  it("PURCHASE GET /:id/pdf — userB 404 with NO file content; userA + owner get a PDF", async () => {
    const foreign = await request(srv()).get(`/api/v1/purchase-invoices/${purchaseA}/pdf`).set(A(userB));
    expect(foreign.status).toBe(404);
    carriesNoInvoiceContent(foreign, purchaseA);
    for (const t of [userA, owner]) {
      const ok = await request(srv()).get(`/api/v1/purchase-invoices/${purchaseA}/pdf`).set(A(t)).buffer(true);
      expect(ok.status).toBe(200);
      expect(ok.headers["content-type"]).toContain("pdf");
    }
  });

  it("SALES PUT /:id — userB 404 and the branch-A draft is UNCHANGED; userA can edit", async () => {
    const before = await h.prisma.salesInvoice.findUnique({ where: { id: draftForUpdate } });
    const res = await request(srv()).put(`/api/v1/sales-invoices/${draftForUpdate}`).set(A(userB)).send({ notes: "اختراق" });
    expect(res.status).toBe(404);
    carriesNoInvoiceContent(res, draftForUpdate);
    const after = await h.prisma.salesInvoice.findUnique({ where: { id: draftForUpdate } });
    expect(after!.notes).toBe(before!.notes); // write did not land
    // userA (branch A) legitimately edits it.
    expect((await request(srv()).put(`/api/v1/sales-invoices/${draftForUpdate}`).set(A(userA)).send({ notes: "تعديل مسموح" })).status).toBeLessThan(300);
    expect((await h.prisma.salesInvoice.findUnique({ where: { id: draftForUpdate } }))!.notes).toBe("تعديل مسموح");
  });

  it("SALES POST /:id/confirm — userB 404 and the draft stays DRAFT; userA can confirm", async () => {
    const res = await request(srv()).post(`/api/v1/sales-invoices/${draftForConfirm}/confirm`).set(A(userB)).send({});
    expect(res.status).toBe(404);
    expect((await h.prisma.salesInvoice.findUnique({ where: { id: draftForConfirm } }))!.status).toBe("DRAFT");
    // userA (branch A) legitimately confirms it.
    expect((await request(srv()).post(`/api/v1/sales-invoices/${draftForConfirm}/confirm`).set(A(userA)).send({})).status).toBeLessThan(300);
    expect((await h.prisma.salesInvoice.findUnique({ where: { id: draftForConfirm } }))!.status).toBe("CONFIRMED");
  });
});
