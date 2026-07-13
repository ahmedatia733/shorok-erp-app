/**
 * Phase 4B-2 — Receipt voucher DRAFT lifecycle (CRUD, validation, list/detail).
 * Posting/reversal GL behavior lives in receipt-voucher-posting.spec.ts.
 *
 * Covers: create (minimal + allocations), treasury/customer/branch validation,
 * allocation eligibility + balance + mismatch rules, strict-schema rejections,
 * update/delete draft guards, and list filtering + detail serialization.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("receipt vouchers — draft lifecycle (Phase 4B-2)", () => {
  let handle: TestApp;
  let ownerToken: string;
  let customerId: string;
  let otherCustomerId: string;
  let otherBranchId: string;
  let treasuryId: string;
  let arAccountId: string;
  let nonTreasuryId: string;

  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });
  const server = () => handle.app.getHttpServer();

  const mkInvoice = async (opts: { grandTotal: string; customerId?: string; branchId?: string; status?: string }) =>
    handle.prisma.salesInvoice.create({
      data: {
        invoiceDate: new Date("2026-07-10"),
        customerId: opts.customerId ?? customerId,
        branchId: opts.branchId ?? handle.branchId,
        status: opts.status ?? "CONFIRMED",
        subtotal: opts.grandTotal,
        grandTotal: opts.grandTotal,
        createdBy: handle.ownerId,
      },
    });

  const base = () => ({ voucherDate: "2026-07-15", branchId: handle.branchId, customerId, treasuryAccountId: treasuryId, amount: "1000.00" });
  const create = (body: Record<string, unknown>) => request(server()).post("/api/v1/receipt-vouchers").set(auth()).send(body);

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    ownerToken = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;

    customerId = (await handle.prisma.customer.create({ data: { code: "RV-C1", nameAr: "عميل واحد" } })).id;
    otherCustomerId = (await handle.prisma.customer.create({ data: { code: "RV-C2", nameAr: "عميل اثنان" } })).id;
    otherBranchId = (await handle.prisma.branch.create({ data: { nameAr: "فرع آخر", nameEn: "Other", active: true } })).id;

    const uniq = Date.now().toString().slice(-6);
    treasuryId = (await handle.prisma.account.create({ data: { code: `RVT${uniq}`, nameAr: "خزينة", nameEn: "Cash", category: "ASSET", accountType: "CURRENT_ASSET", isLeaf: true, active: true, isCashOrBank: true, treasuryType: "CASH" } })).id;
    arAccountId = (await handle.prisma.account.create({ data: { code: `RVAR${uniq}`, nameAr: "عملاء", nameEn: "AR", category: "ASSET", accountType: "CURRENT_ASSET", isLeaf: true, active: true, systemRole: "AR_CONTROL" } })).id;
    nonTreasuryId = (await handle.prisma.account.create({ data: { code: `RVX${uniq}`, nameAr: "مصروف", nameEn: "Exp", category: "EXPENSE", accountType: "EXPENSE", isLeaf: true, active: true } })).id;
  });

  afterAll(async () => teardownTestApp(handle));

  // ── create ───────────────────────────────────────────────────────────
  it("creates a minimal DRAFT voucher", async () => {
    const res = await create(base());
    expect(res.status).toBeLessThan(300);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.amount).toBe("1000.00");
    expect(res.body.journalEntryId).toBeNull();
    expect(String(res.body.voucherNumber)).toMatch(/^\d+$/);
    expect(res.body.treasuryAccountCode).toBe(res.body.treasuryAccountCode);
  });

  it("creates a DRAFT with allocations and returns them in detail", async () => {
    const inv = await mkInvoice({ grandTotal: "600.00" });
    const res = await create({ ...base(), amount: "600.00", allocations: [{ salesInvoiceId: inv.id, amount: "600.00" }] });
    expect(res.status).toBeLessThan(300);
    expect(res.body.allocationCount).toBe(1);
    const detail = await request(server()).get(`/api/v1/receipt-vouchers/${res.body.id}`).set(auth());
    expect(detail.body.allocations).toHaveLength(1);
    expect(detail.body.allocations[0].salesInvoiceId).toBe(inv.id);
    expect(detail.body.allocations[0].amount).toBe("600.00");
  });

  it("rejects an unknown treasury account (invalid_treasury_account)", async () => {
    const res = await create({ ...base(), treasuryAccountId: "99999999-9999-9999-9999-999999999999" });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("invalid_treasury_account");
  });

  it("rejects an AR_CONTROL account as treasury", async () => {
    const res = await create({ ...base(), treasuryAccountId: arAccountId });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("invalid_treasury_account");
  });

  it("rejects a non-cash/bank account as treasury", async () => {
    const res = await create({ ...base(), treasuryAccountId: nonTreasuryId });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("invalid_treasury_account");
  });

  it("rejects a non-existent customer (customer_not_found)", async () => {
    const res = await create({ ...base(), customerId: "88888888-8888-8888-8888-888888888888" });
    expect(res.status).toBe(404);
    expect(res.body.details?.reason).toBe("customer_not_found");
  });

  it("rejects a non-existent branch (branch_not_found)", async () => {
    const res = await create({ ...base(), branchId: "77777777-7777-7777-7777-777777777777" });
    expect(res.status).toBe(404);
    expect(res.body.details?.reason).toBe("branch_not_found");
  });

  it("rejects an allocation to a non-existent invoice", async () => {
    const res = await create({ ...base(), allocations: [{ salesInvoiceId: "66666666-6666-6666-6666-666666666666", amount: "100.00" }] });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("allocation_invoice_not_found");
  });

  it("rejects an allocation to an invoice of another customer (allocation_customer_mismatch)", async () => {
    const inv = await mkInvoice({ grandTotal: "500.00", customerId: otherCustomerId });
    const res = await create({ ...base(), allocations: [{ salesInvoiceId: inv.id, amount: "100.00" }] });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("allocation_customer_mismatch");
  });

  it("rejects an allocation to an invoice of another branch (allocation_branch_mismatch)", async () => {
    const inv = await mkInvoice({ grandTotal: "500.00", branchId: otherBranchId });
    const res = await create({ ...base(), allocations: [{ salesInvoiceId: inv.id, amount: "100.00" }] });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("allocation_branch_mismatch");
  });

  it("rejects an allocation to a CANCELLED invoice (allocation_document_not_eligible)", async () => {
    const inv = await mkInvoice({ grandTotal: "500.00", status: "CANCELLED" });
    const res = await create({ ...base(), allocations: [{ salesInvoiceId: inv.id, amount: "100.00" }] });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("allocation_document_not_eligible");
  });

  it("rejects an allocation exceeding the invoice's remaining balance", async () => {
    const inv = await mkInvoice({ grandTotal: "300.00" });
    const res = await create({ ...base(), amount: "1000.00", allocations: [{ salesInvoiceId: inv.id, amount: "400.00" }] });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("allocation_exceeds_invoice_balance");
  });

  it("rejects (400) allocations whose total exceeds the amount at the schema layer", async () => {
    const invA = await mkInvoice({ grandTotal: "400.00" });
    const invB = await mkInvoice({ grandTotal: "400.00" });
    const res = await create({ ...base(), amount: "500.00", allocations: [{ salesInvoiceId: invA.id, amount: "300.00" }, { salesInvoiceId: invB.id, amount: "300.00" }] });
    expect(res.status).toBe(400);
  });

  it("rejects (400) amount = 0 at the schema layer", async () => {
    const res = await create({ ...base(), amount: "0" });
    expect(res.status).toBe(400);
  });

  it("rejects (400) an unknown field (strict schema)", async () => {
    const res = await create({ ...base(), status: "POSTED" });
    expect(res.status).toBe(400);
  });

  // ── update / delete ───────────────────────────────────────────────────
  it("updates a DRAFT (amount + allocations replaced)", async () => {
    const created = (await create(base())).body;
    const inv = await mkInvoice({ grandTotal: "800.00" });
    const res = await request(server()).patch(`/api/v1/receipt-vouchers/${created.id}`).set(auth()).send({ amount: "800.00", allocations: [{ salesInvoiceId: inv.id, amount: "800.00" }] });
    expect(res.status).toBeLessThan(300);
    expect(res.body.amount).toBe("800.00");
    expect(res.body.allocations).toHaveLength(1);
  });

  it("rejects (400) an empty update", async () => {
    const created = (await create(base())).body;
    const res = await request(server()).patch(`/api/v1/receipt-vouchers/${created.id}`).set(auth()).send({});
    expect(res.status).toBe(400);
  });

  it("rejects (400) an update carrying status", async () => {
    const created = (await create(base())).body;
    const res = await request(server()).patch(`/api/v1/receipt-vouchers/${created.id}`).set(auth()).send({ status: "POSTED" });
    expect(res.status).toBe(400);
  });

  it("deletes a DRAFT voucher (204) and it is gone", async () => {
    const created = (await create(base())).body;
    const del = await request(server()).delete(`/api/v1/receipt-vouchers/${created.id}`).set(auth());
    expect(del.status).toBe(204);
    const after = await request(server()).get(`/api/v1/receipt-vouchers/${created.id}`).set(auth());
    expect(after.status).toBe(404);
  });

  it("returns 404 when updating a non-existent voucher", async () => {
    const res = await request(server()).patch(`/api/v1/receipt-vouchers/55555555-5555-5555-5555-555555555555`).set(auth()).send({ amount: "5.00" });
    expect(res.status).toBe(404);
    expect(res.body.details?.reason).toBe("receipt_voucher_not_found");
  });

  // ── list ──────────────────────────────────────────────────────────────
  it("lists vouchers filtered by customer and status", async () => {
    await create({ ...base(), customerId: otherCustomerId });
    const res = await request(server()).get(`/api/v1/receipt-vouchers?customerId=${otherCustomerId}&status=DRAFT`).set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.every((v: { customerId: string; status: string }) => v.customerId === otherCustomerId && v.status === "DRAFT")).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("filters the list by date range", async () => {
    const res = await request(server()).get(`/api/v1/receipt-vouchers?dateFrom=2026-07-01&dateTo=2026-07-31`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.every((v: { voucherDate: string }) => v.voucherDate >= "2026-07-01" && v.voucherDate <= "2026-07-31")).toBe(true);
  });

  it("rejects (400) a list query with dateFrom after dateTo", async () => {
    const res = await request(server()).get(`/api/v1/receipt-vouchers?dateFrom=2026-07-31&dateTo=2026-07-01`).set(auth());
    expect(res.status).toBe(400);
  });

  it("amount/allocation Decimals are serialized as 2dp strings", async () => {
    const inv = await mkInvoice({ grandTotal: "123.40" });
    const created = (await create({ ...base(), amount: "123.40", allocations: [{ salesInvoiceId: inv.id, amount: "123.40" }] })).body;
    expect(created.amount).toBe("123.40");
    const detail = (await request(server()).get(`/api/v1/receipt-vouchers/${created.id}`).set(auth())).body;
    expect(detail.allocations[0].amount).toBe("123.40");
    expect(new Decimal(detail.amount).toFixed(2)).toBe("123.40");
  });
});
