/**
 * T095 — Expenses integration tests.
 *
 * Covers:
 *  - branch-scope isolation: an expense posted to branch A is invisible to a
 *    BRANCH_MANAGER scoped to branch B
 *  - RBAC: VIEWER cannot create; OWNER/BRANCH_MANAGER/ACCOUNTANT can
 *  - amount=0 rejected
 *  - amount<0 rejected for non-OWNER, accepted for OWNER (correction)
 *  - audit row written same-tx with both AR and EN summaries
 *  - GET /expenses with date-range filter
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("expenses", () => {
  let handle: TestApp;
  let ownerToken: string;
  let bmToken: string;
  let accountantToken: string;
  let viewerToken: string;
  let foreignBranchId: string;
  let foreignBmToken: string;

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({
      where: { id: handle.ownerId },
      data: { passwordHash },
    });

    const fb = await handle.prisma.branch.create({
      data: { nameAr: "فرع آخر", nameEn: "Other Branch", active: true },
    });
    foreignBranchId = fb.id;

    await handle.prisma.user.create({
      data: {
        name: "BM",
        phone: "+201700010001",
        passwordHash,
        role: "BRANCH_MANAGER",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: handle.branchId } },
      },
    });
    await handle.prisma.user.create({
      data: {
        name: "Acc",
        phone: "+201700020002",
        passwordHash,
        role: "ACCOUNTANT",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: handle.branchId } },
      },
    });
    await handle.prisma.user.create({
      data: {
        name: "View",
        phone: "+201700030003",
        passwordHash,
        role: "VIEWER",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: handle.branchId } },
      },
    });
    await handle.prisma.user.create({
      data: {
        name: "ForeignBM",
        phone: "+201700040004",
        passwordHash,
        role: "BRANCH_MANAGER",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: foreignBranchId } },
      },
    });

    const login = async (phone: string, password: string) => {
      const res = await request(handle.app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ phone, password });
      return res.body.accessToken as string;
    };
    ownerToken = await login(handle.ownerPhone, "Pwd@2026!");
    bmToken = await login("+201700010001", "Pwd@2026!");
    accountantToken = await login("+201700020002", "Pwd@2026!");
    viewerToken = await login("+201700030003", "Pwd@2026!");
    foreignBmToken = await login("+201700040004", "Pwd@2026!");
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  function api() {
    return request(handle.app.getHttpServer());
  }
  function bearer(t: string) {
    return { Authorization: `Bearer ${t}` };
  }

  it("BRANCH_MANAGER creates an expense; audit row written same-tx with localized summaries", async () => {
    const res = await api()
      .post("/api/v1/expenses")
      .set(bearer(bmToken))
      .send({
        branchId: handle.branchId,
        expenseDate: "2026-05-04",
        description: "Office supplies",
        amount: "120.50",
        paidFromAccount: "branch-safe",
      });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe("120.5");

    const audit = await handle.prisma.auditLog.findFirst({
      where: { entityType: "expense", entityId: res.body.id, action: "CREATE" },
    });
    expect(audit).toBeTruthy();
    expect(audit!.humanReadableSummaryAr).toContain("سجّل");
    expect(audit!.humanReadableSummaryEn).toContain("recorded");
    expect(audit!.humanReadableSummaryEn).toContain("Office supplies");
  });

  it("ACCOUNTANT creates expense", async () => {
    const res = await api()
      .post("/api/v1/expenses")
      .set(bearer(accountantToken))
      .send({
        branchId: handle.branchId,
        expenseDate: "2026-05-04",
        description: "Internet bill",
        amount: "200",
        paidFromAccount: "cash",
      });
    expect(res.status).toBe(201);
  });

  it("VIEWER cannot create (403 forbidden)", async () => {
    const res = await api()
      .post("/api/v1/expenses")
      .set(bearer(viewerToken))
      .send({
        branchId: handle.branchId,
        expenseDate: "2026-05-04",
        description: "x",
        amount: "10",
        paidFromAccount: "cash",
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("amount=0 rejected (validation_failed)", async () => {
    const res = await api()
      .post("/api/v1/expenses")
      .set(bearer(bmToken))
      .send({
        branchId: handle.branchId,
        expenseDate: "2026-05-04",
        description: "zero",
        amount: "0",
        paidFromAccount: "cash",
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("validation_failed");
  });

  it("amount<0 rejected for BRANCH_MANAGER (owner_only_correction)", async () => {
    const res = await api()
      .post("/api/v1/expenses")
      .set(bearer(bmToken))
      .send({
        branchId: handle.branchId,
        expenseDate: "2026-05-04",
        description: "tried correction",
        amount: "-5",
        paidFromAccount: "cash",
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("validation_failed");
    expect(res.body.details?.reason).toBe("owner_only_correction");
  });

  it("amount<0 accepted for OWNER as a correction; audit uses correction summary", async () => {
    const res = await api()
      .post("/api/v1/expenses")
      .set(bearer(ownerToken))
      .send({
        branchId: handle.branchId,
        expenseDate: "2026-05-04",
        description: "Refund prior expense",
        amount: "-50",
        paidFromAccount: "cash",
      });
    expect(res.status).toBe(201);

    const audit = await handle.prisma.auditLog.findFirst({
      where: { entityType: "expense", entityId: res.body.id, action: "CREATE" },
    });
    expect(audit).toBeTruthy();
    expect(audit!.humanReadableSummaryAr).toContain("تسوية");
    expect(audit!.humanReadableSummaryEn).toContain("correction");
  });

  it("foreign-branch BM cannot post against the test branch (BranchScopeGuard)", async () => {
    const res = await api()
      .post("/api/v1/expenses")
      .set(bearer(foreignBmToken))
      .send({
        branchId: handle.branchId,
        expenseDate: "2026-05-04",
        description: "x",
        amount: "10",
        paidFromAccount: "cash",
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("branch_forbidden");
  });

  it("GET /expenses scoped by branch and filtered by date range", async () => {
    // Two expenses: one inside the range, one outside
    await api()
      .post("/api/v1/expenses")
      .set(bearer(ownerToken))
      .send({
        branchId: handle.branchId,
        expenseDate: "2026-04-01",
        description: "April",
        amount: "10",
        paidFromAccount: "cash",
      });
    await api()
      .post("/api/v1/expenses")
      .set(bearer(ownerToken))
      .send({
        branchId: handle.branchId,
        expenseDate: "2026-05-15",
        description: "May",
        amount: "20",
        paidFromAccount: "cash",
      });

    const list = await api()
      .get(`/api/v1/expenses?branchId=${handle.branchId}&from=2026-05-01&to=2026-05-31`)
      .set(bearer(bmToken));
    expect(list.status).toBe(200);
    const dates = (list.body.data as Array<{ description: string }>).map((d) => d.description);
    expect(dates).toContain("May");
    expect(dates).not.toContain("April");
  });

  it("foreign-branch BM cannot read another branch's expenses", async () => {
    const list = await api()
      .get(`/api/v1/expenses?branchId=${handle.branchId}`)
      .set(bearer(foreignBmToken));
    expect(list.status).toBe(403);
    expect(list.body.code).toBe("branch_forbidden");
  });
});
