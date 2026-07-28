/**
 * Multi-treasury API — creation, GL linkage, authorization, branch isolation,
 * opening balances, statements and transfers. Balances are always derived from
 * journal_lines; the GL is the single source of truth.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("treasuries (multi-treasury)", () => {
  let h: TestApp;
  let owner: string, accountant: string, managerA: string, userB: string;
  let branchA: string, branchB: string;
  let openingEquityId: string, cashParentId: string, arControlId: string;
  const acc: Record<string, string> = {};
  const srv = () => h.app.getHttpServer();
  const A = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = async (phone: string) => (await request(srv()).post("/api/v1/auth/login").send({ phone, password: "Pwd@2026!" })).body.accessToken as string;
  const FAKE = "00000000-0000-0000-0000-000000000000";

  const glBalance = async (glAccountId: string) => {
    const r = await h.prisma.journalLine.aggregate({ _sum: { debit: true, credit: true }, where: { accountId: glAccountId } });
    return new Decimal(r._sum.debit?.toString() ?? "0").sub(r._sum.credit?.toString() ?? "0");
  };
  const createTreasury = (body: Record<string, unknown>, token = owner) =>
    request(srv()).post("/api/v1/treasuries").set(A(token)).send(body);

  beforeAll(async () => {
    h = await buildTestApp();
    branchA = h.branchId;
    branchB = (await h.prisma.branch.create({ data: { nameAr: "فرع ب", nameEn: "Branch B", active: true } })).id;
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash } });
    const mkUser = async (name: string, phone: string, role: string, branches: string[]) => {
      const u = await h.prisma.user.create({ data: { name, phone, passwordHash, role: role as never, status: "ACTIVE" } });
      for (const b of branches) await h.prisma.userBranchAccess.create({ data: { userId: u.id, branchId: b } });
      return login(phone);
    };
    owner = await login(h.ownerPhone);
    accountant = await mkUser("محاسب", "+201700000001", "ACCOUNTANT", [branchA, branchB]);
    managerA = await mkUser("مدير أ", "+201700000002", "BRANCH_MANAGER", [branchA]);
    userB = await mkUser("محاسب ب", "+201700000003", "ACCOUNTANT", [branchB]);

    const u = Date.now().toString().slice(-6);
    const mk = async (key: string, code: string, nameAr: string, cat: string, t: string, opts: { treasury?: "CASH" | "BANK"; role?: string; leaf?: boolean } = {}) => {
      acc[key] = (await h.prisma.account.create({ data: {
        code: `${code}${u}`, nameAr, nameEn: nameAr, category: cat as never, accountType: t as never,
        isLeaf: opts.leaf ?? true, active: true,
        ...(opts.treasury ? { isCashOrBank: true, treasuryType: opts.treasury } : {}),
        ...(opts.role ? { systemRole: opts.role as never } : {}),
      } })).id;
    };
    await mk("openingEquity", "OEQ", "رأس المال الافتتاحي", "EQUITY", "EQUITY");
    await mk("cashParent", "CASHP", "النقدية بالصندوق", "ASSET", "CURRENT_ASSET", { leaf: false });
    await mk("existingCash", "XCASH", "خزينة قائمة", "ASSET", "CURRENT_ASSET", { treasury: "CASH" });
    await mk("nonLeaf", "NLEAF", "حساب أب", "ASSET", "CURRENT_ASSET", { leaf: false });
    await mk("nonCash", "NCASH", "حساب غير نقدي", "ASSET", "CURRENT_ASSET");
    await mk("arControl", "ARC", "ذمم مدينة", "ASSET", "CURRENT_ASSET", { role: "AR_CONTROL" });
    openingEquityId = acc.openingEquity; cashParentId = acc.cashParent; arControlId = acc.arControl;
    // Nest existingCash under cashParent so resolveCashParent picks it up for auto-create.
    await h.prisma.account.update({ where: { id: acc.existingCash }, data: { parentId: cashParentId } });

    await h.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), openingEquityAccountId: openingEquityId, arAccountId: arControlId, createdBy: h.ownerId } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
  });
  afterAll(async () => teardownTestApp(h));

  // ── creation + GL linkage ──────────────────────────────────────────────
  let t1: string, t1Gl: string;
  it("1-2. OWNER creates a treasury with an auto-created unique cash/bank leaf GL account", async () => {
    const res = await createTreasury({ nameAr: "خزنة المبيعات", branchId: branchA });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^TRZ-/);
    expect(res.body.glAccountId).toBeTruthy();
    t1 = res.body.id; t1Gl = res.body.glAccountId;
    const gl = await h.prisma.account.findUnique({ where: { id: t1Gl } });
    expect(gl!.isCashOrBank).toBe(true);
    expect(gl!.treasuryType).toBe("CASH");
    expect(gl!.isLeaf).toBe(true);
    expect(gl!.parentId).toBe(cashParentId); // nested under the cash parent
    // first treasury is forced default
    expect(res.body.isDefault).toBe(true);
  });

  it("3. duplicate treasury code is rejected", async () => {
    const first = await createTreasury({ nameAr: "خزنة برمز", code: "DUP-1", branchId: branchA });
    expect(first.status).toBe(201);
    const dup = await createTreasury({ nameAr: "خزنة أخرى", code: "DUP-1", branchId: branchA });
    expect(dup.status).toBe(409);
    expect(dup.body.details?.reason).toBe("treasury_code_exists");
  });

  it("4. reusing a GL account already linked to another treasury is rejected", async () => {
    const res = await createTreasury({ nameAr: "خزنة مكررة الحساب", branchId: branchA, glAccountId: t1Gl });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("gl_account_already_linked");
  });

  it("4b. linking an existing UNUSED cash leaf account succeeds", async () => {
    const res = await createTreasury({ nameAr: "خزنة بحساب قائم", branchId: branchA, glAccountId: acc.existingCash });
    expect(res.status).toBe(201);
    expect(res.body.glAccountId).toBe(acc.existingCash);
  });

  it("5. invalid GL account is rejected (non-leaf / non-cash)", async () => {
    const nonLeaf = await createTreasury({ nameAr: "خزنة غير ورقية", branchId: branchA, glAccountId: acc.nonLeaf });
    expect(nonLeaf.status).toBe(409);
    expect(nonLeaf.body.details?.reason).toBe("gl_account_not_leaf");
    const nonCash = await createTreasury({ nameAr: "خزنة غير نقدية", branchId: branchA, glAccountId: acc.nonCash });
    expect(nonCash.status).toBe(409);
    expect(nonCash.body.details?.reason).toBe("gl_account_not_cash_or_bank");
  });

  it("6. an unauthorized role cannot create a treasury (OWNER only)", async () => {
    expect((await createTreasury({ nameAr: "خزنة محاسب", branchId: branchA }, accountant)).status).toBe(403);
    expect((await createTreasury({ nameAr: "خزنة مدير", branchId: branchA }, managerA)).status).toBe(403);
  });

  // ── branch isolation ────────────────────────────────────────────────────
  let tB: string;
  it("7-8. branch-restricted user cannot access a foreign treasury; no existence leak", async () => {
    tB = (await createTreasury({ nameAr: "خزنة فرع ب", branchId: branchB })).body.id;
    const foreign = await request(srv()).get(`/api/v1/treasuries/${tB}`).set(A(managerA)); // manager only sees branch A
    const missing = await request(srv()).get(`/api/v1/treasuries/${FAKE}`).set(A(managerA));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(Object.keys(foreign.body).sort()).toEqual(Object.keys(missing.body).sort());
    // owner + a branch-B user can read it
    expect((await request(srv()).get(`/api/v1/treasuries/${tB}`).set(A(owner))).status).toBe(200);
    expect((await request(srv()).get(`/api/v1/treasuries/${tB}`).set(A(userB))).status).toBe(200);
  });

  it("9-10. new treasury appears in the authorized list/selector; inactive is hidden from the selector", async () => {
    const listA = (await request(srv()).get("/api/v1/treasuries").set(A(managerA))).body.items;
    expect(listA.some((t: any) => t.id === t1)).toBe(true);
    expect(listA.some((t: any) => t.id === tB)).toBe(false); // branch B hidden from manager A
    // deactivate a non-default, zero-balance treasury and confirm it leaves the selector
    const created = await createTreasury({ nameAr: "خزنة مؤقتة", branchId: branchA });
    const deact = await request(srv()).post(`/api/v1/treasuries/${created.body.id}/deactivate`).set(A(owner)).send({});
    expect(deact.status).toBe(201);
    const sel = (await request(srv()).get("/api/v1/treasuries/selector").set(A(owner))).body.items;
    expect(sel.some((t: any) => t.id === created.body.id)).toBe(false);
    // but still visible in the full list with includeInactive
    const full = (await request(srv()).get("/api/v1/treasuries?includeInactive=true").set(A(owner))).body.items;
    expect(full.some((t: any) => t.id === created.body.id)).toBe(true);
  });

  it("11-12. default treasury cannot be deactivated; permanent delete is not offered (no DELETE route)", async () => {
    const res = await request(srv()).post(`/api/v1/treasuries/${t1}/deactivate`).set(A(owner)).send({});
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("cannot_deactivate_default_treasury");
    // there is no DELETE endpoint for treasuries
    expect((await request(srv()).delete(`/api/v1/treasuries/${t1}`).set(A(owner))).status).toBe(404);
  });

  // ── opening balance ──────────────────────────────────────────────────────
  it("13-14. opening balance posts a balanced journal and updates the treasury + GL balance", async () => {
    const res = await request(srv()).post(`/api/v1/treasuries/${t1}/opening-balance`).set(A(owner)).send({ entryDate: "2026-02-01", amount: "5000.00" });
    expect(res.status).toBe(201);
    expect(res.body.journalEntryId).toBeTruthy();
    expect(res.body.balance).toBe("5000.00");
    // journal is balanced and carries the treasury GL debit + opening-equity credit, with branchId
    const lines = await h.prisma.journalLine.findMany({ where: { journalEntryId: res.body.journalEntryId } });
    const dr = lines.reduce((s, l) => s.add(l.debit.toString()), new Decimal(0));
    const cr = lines.reduce((s, l) => s.add(l.credit.toString()), new Decimal(0));
    expect(dr.toFixed(2)).toBe("5000.00");
    expect(cr.toFixed(2)).toBe(dr.toFixed(2));
    expect(lines.every((l) => l.branchId)).toBe(true); // §30 branchId on lines
    expect((await glBalance(t1Gl)).toFixed(2)).toBe("5000.00");
  });

  it("13b. opening balance is idempotent (same treasury+date+amount does not double-post)", async () => {
    const again = await request(srv()).post(`/api/v1/treasuries/${t1}/opening-balance`).set(A(owner)).send({ entryDate: "2026-02-01", amount: "5000.00" });
    expect(again.status).toBe(201);
    expect(again.body.idempotent).toBe(true);
    expect((await glBalance(t1Gl)).toFixed(2)).toBe("5000.00"); // unchanged
  });

  // ── transfers ────────────────────────────────────────────────────────────
  let src: string, srcGl: string, dst: string, dstGl: string;
  it("setup two funded treasuries for transfers", async () => {
    const s = await createTreasury({ nameAr: "خزنة المصدر", branchId: branchA }); src = s.body.id; srcGl = s.body.glAccountId;
    const d = await createTreasury({ nameAr: "خزنة الوجهة", branchId: branchA }); dst = d.body.id; dstGl = d.body.glAccountId;
    await request(srv()).post(`/api/v1/treasuries/${src}/opening-balance`).set(A(owner)).send({ entryDate: "2026-02-02", amount: "1000.00" });
  });

  it("19,25,29,30. confirm posts Dr destination / Cr source; cancel reverses; balances reconcile to journal lines", async () => {
    const draft = await request(srv()).post("/api/v1/treasuries/transfers").set(A(owner)).send({ transferDate: "2026-03-01", sourceTreasuryId: src, destinationTreasuryId: dst, amount: "400.00" });
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("DRAFT");
    const conf = await request(srv()).post(`/api/v1/treasuries/transfers/${draft.body.id}/confirm`).set(A(owner)).send({});
    expect(conf.status).toBe(201);
    expect(conf.body.status).toBe("CONFIRMED");
    const lines = await h.prisma.journalLine.findMany({ where: { journalEntryId: conf.body.journalEntryId } });
    const destLine = lines.find((l) => l.accountId === dstGl)!;
    const srcLine = lines.find((l) => l.accountId === srcGl)!;
    expect(destLine.debit.toString()).toBe("400");
    expect(srcLine.credit.toString()).toBe("400");
    expect(lines.every((l) => l.branchId)).toBe(true);
    expect((await glBalance(srcGl)).toFixed(2)).toBe("600.00");
    expect((await glBalance(dstGl)).toFixed(2)).toBe("400.00");
    // cancel → reversing journal, balances restored
    const cancel = await request(srv()).post(`/api/v1/treasuries/transfers/${draft.body.id}/cancel`).set(A(owner)).send({ reason: "خطأ في الإدخال" });
    expect(cancel.status).toBe(201);
    expect(cancel.body.status).toBe("CANCELLED");
    expect(cancel.body.reversalJournalEntryId).toBeTruthy();
    expect((await glBalance(srcGl)).toFixed(2)).toBe("1000.00");
    expect((await glBalance(dstGl)).toFixed(2)).toBe("0.00");
  });

  it("20. transfer to the same treasury is rejected", async () => {
    const res = await request(srv()).post("/api/v1/treasuries/transfers").set(A(owner)).send({ transferDate: "2026-03-01", sourceTreasuryId: src, destinationTreasuryId: src, amount: "10.00" });
    expect(res.status).toBe(400); // rejected by schema validation (source ≠ destination)
  });

  it("21. insufficient balance is rejected when negatives are disabled", async () => {
    const draft = await request(srv()).post("/api/v1/treasuries/transfers").set(A(owner)).send({ transferDate: "2026-03-02", sourceTreasuryId: dst, destinationTreasuryId: src, amount: "50.00" }); // dst has 0
    const conf = await request(srv()).post(`/api/v1/treasuries/transfers/${draft.body.id}/confirm`).set(A(owner)).send({});
    expect(conf.status).toBe(409);
    expect(conf.body.details?.reason).toBe("insufficient_treasury_balance");
  });

  it("22. a negative balance is permitted only when the treasury explicitly allows it", async () => {
    const neg = await createTreasury({ nameAr: "خزنة سالبة", branchId: branchA, allowNegativeBalance: true });
    expect(neg.body.allowNegativeBalance).toBe(true);
    const draft = await request(srv()).post("/api/v1/treasuries/transfers").set(A(owner)).send({ transferDate: "2026-03-03", sourceTreasuryId: neg.body.id, destinationTreasuryId: src, amount: "75.00" });
    const conf = await request(srv()).post(`/api/v1/treasuries/transfers/${draft.body.id}/confirm`).set(A(owner)).send({});
    if (conf.status !== 201) throw new Error(`confirm failed: ${conf.status} ${JSON.stringify(conf.body)}`);
    expect(conf.status).toBe(201);
    expect((await glBalance(neg.body.glAccountId)).toFixed(2)).toBe("-75.00");
  });

  it("24,26. confirm cannot run twice; a confirmed transfer cannot be edited", async () => {
    const draft = await request(srv()).post("/api/v1/treasuries/transfers").set(A(owner)).send({ transferDate: "2026-03-04", sourceTreasuryId: src, destinationTreasuryId: dst, amount: "100.00" });
    expect((await request(srv()).post(`/api/v1/treasuries/transfers/${draft.body.id}/confirm`).set(A(owner)).send({})).status).toBe(201);
    const twice = await request(srv()).post(`/api/v1/treasuries/transfers/${draft.body.id}/confirm`).set(A(owner)).send({});
    expect(twice.status).toBe(409);
    expect(twice.body.details?.reason).toBe("transfer_already_confirmed");
    const edit = await request(srv()).patch(`/api/v1/treasuries/transfers/${draft.body.id}`).set(A(owner)).send({ amount: "1.00" });
    expect(edit.status).toBe(409);
    expect(edit.body.details?.reason).toBe("transfer_not_draft");
  });

  it("23. concurrent outgoing transfers cannot both overspend the same treasury", async () => {
    const pot = await createTreasury({ nameAr: "خزنة التزامن", branchId: branchA });
    await request(srv()).post(`/api/v1/treasuries/${pot.body.id}/opening-balance`).set(A(owner)).send({ entryDate: "2026-02-03", amount: "100.00" });
    const d1 = (await request(srv()).post("/api/v1/treasuries/transfers").set(A(owner)).send({ transferDate: "2026-03-05", sourceTreasuryId: pot.body.id, destinationTreasuryId: src, amount: "80.00" })).body.id;
    const d2 = (await request(srv()).post("/api/v1/treasuries/transfers").set(A(owner)).send({ transferDate: "2026-03-05", sourceTreasuryId: pot.body.id, destinationTreasuryId: dst, amount: "80.00" })).body.id;
    const [r1, r2] = await Promise.all([
      request(srv()).post(`/api/v1/treasuries/transfers/${d1}/confirm`).set(A(owner)).send({}),
      request(srv()).post(`/api/v1/treasuries/transfers/${d2}/confirm`).set(A(owner)).send({}),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]); // exactly one wins
    expect((await glBalance(pot.body.glAccountId)).toFixed(2)).toBe("20.00"); // only one 80 left
  });

  // ── statement + reconciliation ─────────────────────────────────────────
  it("28,29. statement is journal-derived; inactive treasury remains reportable; balance reconciles", async () => {
    const stmt = await request(srv()).get(`/api/v1/treasuries/${t1}/statement`).set(A(owner));
    expect(stmt.status).toBe(200);
    expect(stmt.body.closingBalance).toBe("5000.00");
    expect(stmt.body.items.length).toBeGreaterThanOrEqual(1);
    // reconcile: closing == Σ(debit-credit) on the GL
    expect(stmt.body.closingBalance).toBe((await glBalance(t1Gl)).toFixed(2));
  });
});
