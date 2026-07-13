/**
 * Phase 4B-2 — Receipt voucher posting + reversal through the single
 * PostingEngine / ReversalService path.
 *
 * Golden GL: Dr Treasury / Cr AR_CONTROL [CUSTOMER party], balanced, AR resolved
 * from the PostingProfile (never the client). Reversal mirrors the entry to a
 * net-zero pair and marks the voucher REVERSED. OPEN-period required; re-post /
 * re-reverse are idempotent; draft/posted-state guards enforced.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("receipt voucher posting + reversal (Phase 4B-2)", () => {
  let handle: TestApp;
  let ownerToken: string;
  let customerId: string;
  let treasuryId: string;
  let arAccountId: string;

  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });
  const server = () => handle.app.getHttpServer();
  const sum = (lines: Array<{ debit: unknown; credit: unknown }>, k: "debit" | "credit") =>
    lines.reduce((a, l) => a.add((l[k] as { toString(): string }).toString()), new Decimal(0));

  const setProfile = async () => {
    await handle.prisma.postingProfile.deleteMany({});
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId, createdBy: handle.ownerId } });
  };

  const createDraft = async (amount = "1000.00", voucherDate = "2026-07-15") =>
    (await request(server()).post("/api/v1/receipt-vouchers").set(auth()).send({ voucherDate, branchId: handle.branchId, customerId, treasuryAccountId: treasuryId, amount })).body as { id: string; voucherNumber: string };

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    ownerToken = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;

    customerId = (await handle.prisma.customer.create({ data: { code: "RVP-C", nameAr: "عميل الترحيل" } })).id;
    const uniq = Date.now().toString().slice(-6);
    treasuryId = (await handle.prisma.account.create({ data: { code: `RVPT${uniq}`, nameAr: "خزينة", nameEn: "Cash", category: "ASSET", accountType: "CURRENT_ASSET", isLeaf: true, active: true, isCashOrBank: true, treasuryType: "CASH" } })).id;
    arAccountId = (await handle.prisma.account.create({ data: { code: `RVPAR${uniq}`, nameAr: "عملاء", nameEn: "AR", category: "ASSET", accountType: "CURRENT_ASSET", isLeaf: true, active: true, systemRole: "AR_CONTROL" } })).id;
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  it("golden path: Dr Treasury / Cr AR [CUSTOMER party], balanced, POSTED, periodId set", async () => {
    await setProfile();
    const v = await createDraft("1500.00");
    const res = await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/post`).set(auth()).send({});
    expect(res.status).toBeLessThan(300);
    expect(res.body.status).toBe("POSTED");
    expect(res.body.journalEntryId).not.toBeNull();
    expect(res.body.periodId).not.toBeNull();
    expect(res.body.postedBy).toBe(handle.ownerId);

    const je = await handle.prisma.journalEntry.findUnique({ where: { id: res.body.journalEntryId }, include: { lines: true } });
    expect(je!.sourceType).toBe("RECEIPT_VOUCHER");
    const dr = je!.lines.find((l) => l.accountId === treasuryId)!;
    const cr = je!.lines.find((l) => l.accountId === arAccountId)!;
    expect(new Decimal(dr.debit.toString()).toString()).toBe("1500");
    expect(new Decimal(cr.credit.toString()).toString()).toBe("1500");
    expect(cr.partyType).toBe("CUSTOMER");
    expect(cr.partyId).toBe(customerId);
    expect(sum(je!.lines, "debit").eq(sum(je!.lines, "credit"))).toBe(true);
  });

  it("uses the idempotency key RECEIPT_VOUCHER:<id> and re-post is blocked (not_draft), no double JE", async () => {
    await setProfile();
    const v = await createDraft("200.00");
    await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/post`).set(auth()).send({});
    const second = await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/post`).set(auth()).send({});
    expect(second.status).toBe(409);
    expect(second.body.details?.reason).toBe("receipt_voucher_not_draft");
    expect(await handle.prisma.journalEntry.count({ where: { sourceType: "RECEIPT_VOUCHER", sourceId: v.id } })).toBe(1);
  });

  it("requires an AR account from the profile (ar_account_required), stays DRAFT, no JE", async () => {
    await handle.prisma.postingProfile.deleteMany({});
    const v = await createDraft("100.00");
    const res = await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/post`).set(auth()).send({});
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("ar_account_required");
    expect((await handle.prisma.receiptVoucher.findUnique({ where: { id: v.id } }))!.status).toBe("DRAFT");
    expect(await handle.prisma.journalEntry.count({ where: { sourceType: "RECEIPT_VOUCHER", sourceId: v.id } })).toBe(0);
  });

  it("refuses to post into a period that is not OPEN (voucher stays DRAFT, no JE)", async () => {
    await setProfile();
    const v = await createDraft("100.00", "2026-06-15"); // June — no OPEN period
    const res = await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/post`).set(auth()).send({});
    expect(res.status).toBe(409);
    expect((await handle.prisma.receiptVoucher.findUnique({ where: { id: v.id } }))!.status).toBe("DRAFT");
    expect(await handle.prisma.journalEntry.count({ where: { sourceType: "RECEIPT_VOUCHER", sourceId: v.id } })).toBe(0);
  });

  it("reverse: mirror entry, net-zero pair, voucher REVERSED, original REVERSED", async () => {
    await setProfile();
    const v = await createDraft("777.00");
    const posted = (await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/post`).set(auth()).send({})).body;
    const res = await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/reverse`).set(auth()).send({ reason: "خطأ في التسجيل" });
    expect(res.status).toBeLessThan(300);
    expect(res.body.status).toBe("REVERSED");
    expect(res.body.reversalJournalEntryId).not.toBeNull();
    expect(res.body.reversedBy).toBe(handle.ownerId);

    const original = await handle.prisma.journalEntry.findUnique({ where: { id: posted.journalEntryId } });
    expect(original!.status).toBe("REVERSED");
    expect(await handle.prisma.journalEntry.count({ where: { reversalOfId: posted.journalEntryId } })).toBe(1);

    const pair = await handle.prisma.journalLine.findMany({ where: { journalEntry: { OR: [{ id: posted.journalEntryId }, { reversalOfId: posted.journalEntryId }] } } });
    const net = pair.reduce((a, l) => a.add(l.debit.toString()).sub(l.credit.toString()), new Decimal(0));
    expect(net.toString()).toBe("0");
  });

  it("reverse is idempotent: repeating it does not create a second mirror", async () => {
    await setProfile();
    const v = await createDraft("321.00");
    const posted = (await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/post`).set(auth()).send({})).body;
    await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/reverse`).set(auth()).send({ reason: "أول عكس" });
    const again = await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/reverse`).set(auth()).send({ reason: "ثاني عكس" });
    expect(again.status).toBeLessThan(300);
    expect(again.body.status).toBe("REVERSED");
    expect(await handle.prisma.journalEntry.count({ where: { reversalOfId: posted.journalEntryId } })).toBe(1);
  });

  it("reverse on a DRAFT voucher is rejected (receipt_voucher_not_posted)", async () => {
    const v = await createDraft("50.00");
    const res = await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/reverse`).set(auth()).send({ reason: "لا يمكن" });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("receipt_voucher_not_posted");
  });

  it("a POSTED voucher cannot be deleted (use_reverse_instead)", async () => {
    await setProfile();
    const v = await createDraft("60.00");
    await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/post`).set(auth()).send({});
    const del = await request(server()).delete(`/api/v1/receipt-vouchers/${v.id}`).set(auth());
    expect(del.status).toBe(409);
    expect(del.body.details?.reason).toBe("use_reverse_instead");
  });

  it("a POSTED voucher cannot be updated (receipt_voucher_not_draft)", async () => {
    await setProfile();
    const v = await createDraft("70.00");
    await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/post`).set(auth()).send({});
    const upd = await request(server()).patch(`/api/v1/receipt-vouchers/${v.id}`).set(auth()).send({ amount: "80.00" });
    expect(upd.status).toBe(409);
    expect(upd.body.details?.reason).toBe("receipt_voucher_not_draft");
  });

  it("preserves allocations through posting (metadata only, GL is the total)", async () => {
    await setProfile();
    const inv = await handle.prisma.salesInvoice.create({ data: { invoiceDate: new Date("2026-07-10"), customerId, branchId: handle.branchId, status: "CONFIRMED", subtotal: "400.00", grandTotal: "400.00", createdBy: handle.ownerId } });
    const v = (await request(server()).post("/api/v1/receipt-vouchers").set(auth()).send({ voucherDate: "2026-07-15", branchId: handle.branchId, customerId, treasuryAccountId: treasuryId, amount: "400.00", allocations: [{ salesInvoiceId: inv.id, amount: "400.00" }] })).body;
    const posted = await request(server()).post(`/api/v1/receipt-vouchers/${v.id}/post`).set(auth()).send({});
    expect(posted.status).toBeLessThan(300);
    expect(posted.body.allocations).toHaveLength(1);
    const je = await handle.prisma.journalEntry.findUnique({ where: { id: posted.body.journalEntryId }, include: { lines: true } });
    expect(sum(je!.lines, "debit").toString()).toBe("400");
  });
});
