/**
 * Returns ROLE-BASED permission matrix (§4), enforced server-side via @Roles +
 * RolesGuard (Option B). VIEW is broad; CREATE/CONFIRM are accountant-level;
 * CANCEL is OWNER-only. Denied actions return 403 BEFORE any mutation.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("returns permissions matrix (§4)", () => {
  let h: TestApp;
  let owner: string, accountant: string, manager: string;
  let repId: string, customerId: string, supplierId: string;
  const acc: Record<string, string> = {};
  const A = (t: string) => ({ Authorization: `Bearer ${t}` });
  const srv = () => h.app.getHttpServer();
  const login = async (phone: string) => (await request(srv()).post("/api/v1/auth/login").send({ phone, password: "Pwd@2026!" })).body.accessToken as string;
  let invId: string, lineId: string;

  const mkDraft = (tok: string) =>
    request(srv()).post("/api/v1/sales-returns").set(A(tok)).send({ originalSalesInvoiceId: invId, returnDate: "2026-03-15", lines: [{ originalSalesInvoiceLineId: lineId, returnedMeters: "1", returnedBoards: "1" }] });

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    owner = await login(h.ownerPhone);
    const mkUser = async (phone: string, role: any) => {
      const u = await h.prisma.user.create({ data: { name: phone, phone, passwordHash: await bcrypt.hash("Pwd@2026!", 10), role, status: "ACTIVE" } });
      await h.prisma.userBranchAccess.create({ data: { userId: u.id, branchId: h.branchId } });
      return login(phone);
    };
    accountant = await mkUser("+201110000011", "ACCOUNTANT");
    manager = await mkUser("+201110000012", "BRANCH_MANAGER");
    repId = (await h.prisma.salesRepresentative.create({ data: { code: "PR", nameAr: "م" } })).id;
    customerId = (await h.prisma.customer.create({ data: { code: "PC", nameAr: "ع" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;
    const u = Date.now().toString().slice(-6);
    const mk = async (k: string, code: string, cat: any, t: any, role?: string) => {
      acc[k] = (await h.prisma.account.create({ data: { code: `${code}${u}`, nameAr: code, nameEn: code, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } })).id;
    };
    await mk("ar", "AR", "ASSET", "CURRENT_ASSET", "AR_CONTROL"); await mk("ap", "AP", "LIABILITY", "LIABILITY", "AP_CONTROL");
    await mk("rev", "RV", "REVENUE", "REVENUE"); await mk("sret", "SR", "REVENUE", "REVENUE");
    await mk("vatO", "VO", "LIABILITY", "LIABILITY"); await mk("cogs", "CG", "COST_OF_SALES", "COST_OF_SALES"); await mk("inv", "IN", "ASSET", "CURRENT_ASSET");
    await h.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev, salesReturnsAccountId: acc.sret, vatOutputAccountId: acc.vatO, cogsAccountId: acc.cogs, inventoryAccountId: acc.inv, createdBy: h.ownerId } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
    const sku = await h.prisma.productSku.create({ data: { code: "PS-1", category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    const v = (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(A(owner)).send({ invoiceDate: "2026-02-01", supplierId, branchId: h.branchId, lines: [{ productVariantId: v, boardsQuantity: "20", unitPrice: "300", taxRate: "0" }] });
    await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(A(owner)).send({});
    const s = await request(srv()).post("/api/v1/sales-invoices").set(A(owner)).send({ invoiceDate: "2026-03-01", customerId, branchId: h.branchId, taxRate: "0", salesRepresentativeId: repId, lines: [{ productVariantId: v, quantity: "10", unitPrice: "500", costPrice: "0" }] });
    await request(srv()).post(`/api/v1/sales-invoices/${s.body.id}/confirm`).set(A(owner)).send({});
    invId = s.body.id;
    lineId = (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: invId } }))!.id;
  });
  afterAll(async () => teardownTestApp(h));

  it("BRANCH_MANAGER: VIEW allowed; CREATE/CONFIRM/CANCEL denied 403 (no mutation on denied create)", async () => {
    expect((await request(srv()).get(`/api/v1/sales-returns/returnable/${invId}`).set(A(manager))).status).toBe(200);
    expect((await request(srv()).get(`/api/v1/sales-returns`).set(A(manager))).status).toBe(200);
    const before = await h.prisma.salesReturn.count();
    const create = await mkDraft(manager);
    expect(create.status).toBe(403);
    expect(await h.prisma.salesReturn.count()).toBe(before); // 403 BEFORE any mutation
    // Confirm/cancel on an owner-created draft are also denied for the manager.
    const draft = await mkDraft(owner);
    expect((await request(srv()).post(`/api/v1/sales-returns/${draft.body.id}/confirm`).set(A(manager)).send({})).status).toBe(403);
    const confirmed = await request(srv()).post(`/api/v1/sales-returns/${draft.body.id}/confirm`).set(A(owner)).send({});
    expect(confirmed.status).toBeLessThan(300);
    expect((await request(srv()).post(`/api/v1/sales-returns/${draft.body.id}/cancel`).set(A(manager)).send({})).status).toBe(403);
  });

  it("ACCOUNTANT: CREATE/UPDATE/CONFIRM allowed; CANCEL denied 403", async () => {
    const create = await mkDraft(accountant);
    expect(create.status).toBeLessThan(300);
    const upd = await request(srv()).put(`/api/v1/sales-returns/${create.body.id}`).set(A(accountant)).send({ lines: [{ originalSalesInvoiceLineId: lineId, returnedMeters: "2", returnedBoards: "1" }] });
    expect(upd.status).toBeLessThan(300);
    const confirm = await request(srv()).post(`/api/v1/sales-returns/${create.body.id}/confirm`).set(A(accountant)).send({});
    expect(confirm.status).toBeLessThan(300);
    // CANCEL is OWNER-only.
    expect((await request(srv()).post(`/api/v1/sales-returns/${create.body.id}/cancel`).set(A(accountant)).send({})).status).toBe(403);
    // OWNER can cancel.
    expect((await request(srv()).post(`/api/v1/sales-returns/${create.body.id}/cancel`).set(A(owner)).send({})).status).toBeLessThan(300);
  });

  it("OWNER: create → confirm → cancel all allowed", async () => {
    const create = await mkDraft(owner);
    expect(create.status).toBeLessThan(300);
    expect((await request(srv()).post(`/api/v1/sales-returns/${create.body.id}/confirm`).set(A(owner)).send({})).status).toBeLessThan(300);
    expect((await request(srv()).post(`/api/v1/sales-returns/${create.body.id}/cancel`).set(A(owner)).send({})).status).toBeLessThan(300);
  });

  it("purchase returns enforce the same matrix (manager create denied, accountant cancel denied)", async () => {
    const pinv = (await h.prisma.purchaseInvoice.findFirst({ where: { branchId: h.branchId } }))!;
    const pl = (await h.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: pinv.id } }))!.id;
    const body = { originalPurchaseInvoiceId: pinv.id, returnDate: "2026-04-01", lines: [{ originalPurchaseInvoiceLineId: pl, returnedMeters: "4", returnedBoards: "1" }] };
    expect((await request(srv()).post("/api/v1/purchase-returns").set(A(manager)).send(body)).status).toBe(403);
    const created = await request(srv()).post("/api/v1/purchase-returns").set(A(accountant)).send(body);
    expect(created.status).toBeLessThan(300);
    expect((await request(srv()).post(`/api/v1/purchase-returns/${created.body.id}/confirm`).set(A(accountant)).send({})).status).toBeLessThan(300);
    expect((await request(srv()).post(`/api/v1/purchase-returns/${created.body.id}/cancel`).set(A(accountant)).send({})).status).toBe(403);
  });
});
