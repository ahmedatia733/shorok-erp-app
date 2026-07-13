/**
 * Phase 4B-2 hardening — allocation balance is consumed only by POSTED vouchers.
 * DRAFT allocations are provisional; REVERSED release their amount; the current
 * voucher is excluded from its own revalidation; concurrent posts to one invoice
 * cannot both over-allocate (SELECT … FOR UPDATE serializes them).
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("receipt voucher allocation balance (Phase 4B-2)", () => {
  let handle: TestApp;
  let ownerToken: string;
  let customerId: string;
  let treasuryId: string;
  let arAccountId: string;

  const server = () => handle.app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

  const mkInvoice = (grandTotal: string) =>
    handle.prisma.salesInvoice.create({ data: { invoiceDate: new Date("2026-07-10"), customerId, branchId: handle.branchId, status: "CONFIRMED", subtotal: grandTotal, grandTotal, createdBy: handle.ownerId } });

  const createDraft = (amount: string, invoiceId?: string, allocAmount?: string) =>
    request(server()).post("/api/v1/receipt-vouchers").set(auth()).send({
      voucherDate: "2026-07-15", branchId: handle.branchId, customerId, treasuryAccountId: treasuryId, amount,
      ...(invoiceId ? { allocations: [{ salesInvoiceId: invoiceId, amount: allocAmount ?? amount }] } : {}),
    });
  const post = (id: string) => request(server()).post(`/api/v1/receipt-vouchers/${id}/post`).set(auth()).send({});
  const reverse = (id: string) => request(server()).post(`/api/v1/receipt-vouchers/${id}/reverse`).set(auth()).send({ reason: "تصحيح" });

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    ownerToken = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;

    customerId = (await handle.prisma.customer.create({ data: { code: "RVA-C", nameAr: "عميل" } })).id;
    const uniq = Date.now().toString().slice(-6);
    treasuryId = (await handle.prisma.account.create({ data: { code: `RVAT${uniq}`, nameAr: "خزينة", nameEn: "Cash", category: "ASSET", accountType: "CURRENT_ASSET", isLeaf: true, active: true, isCashOrBank: true, treasuryType: "CASH" } })).id;
    arAccountId = (await handle.prisma.account.create({ data: { code: `RVAAR${uniq}`, nameAr: "عملاء", nameEn: "AR", category: "ASSET", accountType: "CURRENT_ASSET", isLeaf: true, active: true, systemRole: "AR_CONTROL" } })).id;
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId, createdBy: handle.ownerId } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  it("1) a DRAFT voucher's allocation does NOT reduce the invoice's remaining balance", async () => {
    const inv = await mkInvoice("1000.00");
    const v1 = await createDraft("600.00", inv.id, "600.00"); // DRAFT, alloc 600
    expect(v1.status).toBeLessThan(300);
    // A second draft can still allocate the full 1000 — the first draft consumes nothing.
    const v2 = await createDraft("1000.00", inv.id, "1000.00");
    expect(v2.status).toBeLessThan(300);
  });

  it("2) deleting a DRAFT does not affect the invoice balance", async () => {
    const inv = await mkInvoice("1000.00");
    const v1 = (await createDraft("600.00", inv.id, "600.00")).body;
    expect((await request(server()).delete(`/api/v1/receipt-vouchers/${v1.id}`).set(auth())).status).toBe(204);
    const v2 = await createDraft("1000.00", inv.id, "1000.00");
    expect(v2.status).toBeLessThan(300); // full balance still available
  });

  it("3) a POSTED voucher reduces the remaining balance", async () => {
    const inv = await mkInvoice("1000.00");
    const v1 = (await createDraft("600.00", inv.id, "600.00")).body;
    expect((await post(v1.id)).status).toBeLessThan(300); // POSTED consumes 600 → remaining 400
    const over = await createDraft("500.00", inv.id, "500.00");
    expect(over.status).toBe(409);
    expect(over.body.details?.reason).toBe("allocation_exceeds_invoice_balance");
    const ok = await createDraft("400.00", inv.id, "400.00"); // exactly the remaining 400
    expect(ok.status).toBeLessThan(300);
  });

  it("4) a REVERSED voucher releases its amount for reuse", async () => {
    const inv = await mkInvoice("1000.00");
    const v1 = (await createDraft("1000.00", inv.id, "1000.00")).body;
    await post(v1.id); // remaining 0
    expect((await createDraft("1000.00", inv.id, "1000.00")).status).toBe(409); // nothing left
    expect((await reverse(v1.id)).status).toBeLessThan(300); // release
    const reused = await createDraft("1000.00", inv.id, "1000.00");
    expect(reused.status).toBeLessThan(300); // full balance available again
  });

  it("5) allocations remain visible after reversal (audit trail retained)", async () => {
    const inv = await mkInvoice("1000.00");
    const v1 = (await createDraft("1000.00", inv.id, "1000.00")).body;
    await post(v1.id);
    await reverse(v1.id);
    const detail = (await request(server()).get(`/api/v1/receipt-vouchers/${v1.id}`).set(auth())).body;
    expect(detail.status).toBe("REVERSED");
    expect(detail.allocations).toHaveLength(1);
    expect(detail.allocations[0].amount).toBe("1000.00");
  });

  it("6) over-allocation against POSTED allocations is rejected", async () => {
    const inv = await mkInvoice("1000.00");
    const v1 = (await createDraft("700.00", inv.id, "700.00")).body;
    await post(v1.id); // remaining 300
    const over = await createDraft("400.00", inv.id, "400.00");
    expect(over.status).toBe(409);
    expect(over.body.details?.reason).toBe("allocation_exceeds_invoice_balance");
  });

  it("7) two concurrent posts cannot both over-allocate the same invoice", async () => {
    const inv = await mkInvoice("1000.00");
    const v1 = (await createDraft("600.00", inv.id, "600.00")).body;
    const v2 = (await createDraft("600.00", inv.id, "600.00")).body; // 600 + 600 > 1000
    const [r1, r2] = await Promise.all([post(v1.id), post(v2.id)]);
    const statuses = [r1.status, r2.status].sort();
    const okCount = [r1, r2].filter((r) => r.status < 300).length;
    const rejCount = [r1, r2].filter((r) => r.status === 409).length;
    expect(okCount).toBe(1);
    expect(rejCount).toBe(1);
    expect(statuses[0]).toBeLessThan(300);
    const rejected = [r1, r2].find((r) => r.status === 409)!;
    expect(rejected.body.details?.reason).toBe("allocation_exceeds_invoice_balance");
    // Exactly one journal entry hit the ledger; only 600 of the invoice consumed.
    const jeCount = await handle.prisma.journalEntry.count({ where: { sourceType: "RECEIPT_VOUCHER", sourceId: { in: [v1.id, v2.id] } } });
    expect(jeCount).toBe(1);
    const consumed = await handle.prisma.receiptVoucherAllocation.aggregate({ _sum: { amount: true }, where: { salesInvoiceId: inv.id, receiptVoucher: { status: "POSTED" } } });
    expect(new Decimal(consumed._sum.amount?.toString() ?? "0").toString()).toBe("600");
  });

  it("8) re-post is idempotent and creates no duplicate journal", async () => {
    const inv = await mkInvoice("1000.00");
    const v1 = (await createDraft("500.00", inv.id, "500.00")).body;
    expect((await post(v1.id)).status).toBeLessThan(300);
    const second = await post(v1.id);
    expect(second.status).toBe(409);
    expect(second.body.details?.reason).toBe("receipt_voucher_not_draft");
    expect(await handle.prisma.journalEntry.count({ where: { sourceType: "RECEIPT_VOUCHER", sourceId: v1.id } })).toBe(1);
  });
});
