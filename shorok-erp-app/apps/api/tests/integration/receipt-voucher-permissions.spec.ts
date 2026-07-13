/**
 * Phase 4B-2 hardening — Receipt voucher permission matrix + branch scoping.
 *
 * Roles: read + create/update/delete/post = OWNER, ACCOUNTANT, BRANCH_MANAGER;
 * reverse = OWNER, ACCOUNTANT only; WAREHOUSE has no access; unauthenticated 401.
 * A BRANCH_MANAGER is confined to its allowed branch(es) and cannot reach another
 * branch's voucher by swapping the id or the branchId.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("receipt voucher permissions + branch scoping (Phase 4B-2)", () => {
  let handle: TestApp;
  let branchA: string;
  let branchB: string;
  let customerId: string;
  let treasuryId: string;

  let ownerTok: string, bmA: string, bmB: string, accTok: string, whTok: string;

  const server = () => handle.app.getHttpServer();
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const draft = (branchId: string) => ({ voucherDate: "2026-07-15", branchId, customerId, treasuryAccountId: treasuryId, amount: "100.00" });
  const createAs = (tok: string, branchId: string) => request(server()).post("/api/v1/receipt-vouchers").set(H(tok)).send(draft(branchId));

  beforeAll(async () => {
    handle = await buildTestApp();
    branchA = handle.branchId;
    branchB = (await handle.prisma.branch.create({ data: { nameAr: "فرع ب", nameEn: "Branch B", active: true } })).id;

    const pw = "Pwd@2026!";
    const passwordHash = await bcrypt.hash(pw, 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    const mkUser = (name: string, phone: string, role: string, branchId: string) =>
      handle.prisma.user.create({ data: { name, phone, passwordHash, role: role as never, status: "ACTIVE", branchAccesses: { create: { branchId } } } });
    await mkUser("BM-A", "+201700000001", "BRANCH_MANAGER", branchA);
    await mkUser("BM-B", "+201700000002", "BRANCH_MANAGER", branchB);
    await mkUser("Acc", "+201700000003", "ACCOUNTANT", branchA);
    await mkUser("WH", "+201700000004", "WAREHOUSE", branchA);

    const login = async (phone: string) => (await request(server()).post("/api/v1/auth/login").send({ phone, password: pw })).body.accessToken;
    ownerTok = await login(handle.ownerPhone);
    bmA = await login("+201700000001");
    bmB = await login("+201700000002");
    accTok = await login("+201700000003");
    whTok = await login("+201700000004");

    customerId = (await handle.prisma.customer.create({ data: { code: "RVP-C", nameAr: "عميل" } })).id;
    const uniq = Date.now().toString().slice(-6);
    treasuryId = (await handle.prisma.account.create({ data: { code: `RVPT${uniq}`, nameAr: "خزينة", nameEn: "Cash", category: "ASSET", accountType: "CURRENT_ASSET", isLeaf: true, active: true, isCashOrBank: true, treasuryType: "CASH" } })).id;
    const arId = (await handle.prisma.account.create({ data: { code: `RVPAR${uniq}`, nameAr: "عملاء", nameEn: "AR", category: "ASSET", accountType: "CURRENT_ASSET", isLeaf: true, active: true, systemRole: "AR_CONTROL" } })).id;
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: arId, createdBy: handle.ownerId } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  // ── unauthenticated ───────────────────────────────────────────────────
  it("unauthenticated GET is 401", async () => {
    expect((await request(server()).get("/api/v1/receipt-vouchers")).status).toBe(401);
    expect((await request(server()).post("/api/v1/receipt-vouchers").send(draft(branchA))).status).toBe(401);
  });

  // ── WAREHOUSE denied everywhere ────────────────────────────────────────
  it("WAREHOUSE is denied read / create / update / post / reverse (403)", async () => {
    const ownerVoucher = (await createAs(ownerTok, branchA)).body;
    expect((await request(server()).get("/api/v1/receipt-vouchers").set(H(whTok))).status).toBe(403);
    expect((await request(server()).get(`/api/v1/receipt-vouchers/${ownerVoucher.id}`).set(H(whTok))).status).toBe(403);
    expect((await createAs(whTok, branchA)).status).toBe(403);
    expect((await request(server()).patch(`/api/v1/receipt-vouchers/${ownerVoucher.id}`).set(H(whTok)).send({ amount: "5.00" })).status).toBe(403);
    expect((await request(server()).delete(`/api/v1/receipt-vouchers/${ownerVoucher.id}`).set(H(whTok))).status).toBe(403);
    expect((await request(server()).post(`/api/v1/receipt-vouchers/${ownerVoucher.id}/post`).set(H(whTok)).send({})).status).toBe(403);
    expect((await request(server()).post(`/api/v1/receipt-vouchers/${ownerVoucher.id}/reverse`).set(H(whTok)).send({ reason: "no" })).status).toBe(403);
  });

  // ── BRANCH_MANAGER within its branch ───────────────────────────────────
  it("BRANCH_MANAGER is allowed the full draft+post lifecycle within its branch", async () => {
    const created = await createAs(bmA, branchA);
    expect(created.status).toBeLessThan(300);
    const id = created.body.id;
    expect((await request(server()).get(`/api/v1/receipt-vouchers/${id}`).set(H(bmA))).status).toBe(200);
    expect((await request(server()).get("/api/v1/receipt-vouchers").set(H(bmA))).status).toBe(200);
    expect((await request(server()).patch(`/api/v1/receipt-vouchers/${id}`).set(H(bmA)).send({ amount: "150.00" })).status).toBeLessThan(300);
    expect((await request(server()).post(`/api/v1/receipt-vouchers/${id}/post`).set(H(bmA)).send({})).status).toBeLessThan(300);
  });

  it("ACCOUNTANT can create+post within its branch", async () => {
    const created = await createAs(accTok, branchA);
    expect(created.status).toBeLessThan(300);
    expect((await request(server()).post(`/api/v1/receipt-vouchers/${created.body.id}/post`).set(H(accTok)).send({})).status).toBeLessThan(300);
  });

  // ── BRANCH_MANAGER outside its branch ──────────────────────────────────
  it("BRANCH_MANAGER cannot create a voucher for another branch (403)", async () => {
    expect((await createAs(bmA, branchB)).status).toBe(403);
  });

  it("BRANCH_MANAGER cannot read / update / delete / post another branch's voucher by id (403)", async () => {
    const foreign = (await createAs(bmB, branchB)).body; // created by the branch-B manager
    expect((await request(server()).get(`/api/v1/receipt-vouchers/${foreign.id}`).set(H(bmA))).status).toBe(403);
    expect((await request(server()).patch(`/api/v1/receipt-vouchers/${foreign.id}`).set(H(bmA)).send({ amount: "9.00" })).status).toBe(403);
    expect((await request(server()).delete(`/api/v1/receipt-vouchers/${foreign.id}`).set(H(bmA))).status).toBe(403);
    expect((await request(server()).post(`/api/v1/receipt-vouchers/${foreign.id}/post`).set(H(bmA)).send({})).status).toBe(403);
  });

  it("BRANCH_MANAGER's list is scoped to its branch (foreign vouchers excluded)", async () => {
    await createAs(bmB, branchB); // a branch-B voucher exists
    const res = await request(server()).get("/api/v1/receipt-vouchers").set(H(bmA));
    expect(res.status).toBe(200);
    expect(res.body.data.every((v: { branchId: string }) => v.branchId === branchA)).toBe(true);
  });

  // ── reverse restricted to OWNER / ACCOUNTANT ───────────────────────────
  it("BRANCH_MANAGER is denied reverse even within its branch (403)", async () => {
    const created = await createAs(bmA, branchA);
    await request(server()).post(`/api/v1/receipt-vouchers/${created.body.id}/post`).set(H(bmA)).send({});
    const rev = await request(server()).post(`/api/v1/receipt-vouchers/${created.body.id}/reverse`).set(H(bmA)).send({ reason: "محاولة عكس" });
    expect(rev.status).toBe(403);
    // ACCOUNTANT (same branch) may reverse it.
    const ok = await request(server()).post(`/api/v1/receipt-vouchers/${created.body.id}/reverse`).set(H(accTok)).send({ reason: "عكس مصرح" });
    expect(ok.status).toBeLessThan(300);
    expect(ok.body.status).toBe("REVERSED");
  });
});
