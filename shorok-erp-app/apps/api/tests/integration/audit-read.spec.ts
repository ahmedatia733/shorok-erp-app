/**
 * T117 — Audit read endpoint integration tests.
 *
 * Pinned behaviour:
 *  - GET /audit returns rows newest-first with cursor pagination
 *  - entityType + entityId filter narrows to one entity
 *  - actorId filter narrows to one user's actions
 *  - from/to (yyyy-mm-dd) date range filters createdAt
 *  - BRANCH_MANAGER sees only branch-scoped entity types
 *    (customer_order, expense, inventory_movement)
 *  - GET /audit/by-actor/:userId is OWNER only; other roles → 403
 *  - audit_logs is append-only; no UPDATE / DELETE endpoints exist
 *    (REVOKE in migration enforces at the DB role level — covered
 *    again in append-only.spec.ts at T139)
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("audit read", () => {
  let handle: TestApp;
  let ownerToken: string;
  let bmToken: string;
  let bmUserId: string;

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({
      where: { id: handle.ownerId },
      data: { passwordHash },
    });

    const bm = await handle.prisma.user.create({
      data: {
        name: "BM",
        phone: "+201700010001",
        passwordHash,
        role: "BRANCH_MANAGER",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: handle.branchId } },
      },
    });
    bmUserId = bm.id;

    const login = async (phone: string, password: string) => {
      const res = await request(handle.app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ phone, password });
      return res.body.accessToken as string;
    };
    ownerToken = await login(handle.ownerPhone, "Pwd@2026!");
    bmToken = await login("+201700010001", "Pwd@2026!");

    // Generate audit rows: 3 OWNER expenses + 2 BM expenses
    const post = async (token: string, description: string, amount: string) =>
      request(handle.app.getHttpServer())
        .post("/api/v1/expenses")
        .set({ Authorization: `Bearer ${token}` })
        .send({
          branchId: handle.branchId,
          expenseDate: "2026-05-04",
          description,
          amount,
          paidFromAccount: "cash",
        });
    await post(ownerToken, "owner-1", "10");
    await post(ownerToken, "owner-2", "20");
    await post(bmToken, "bm-1", "30");
    await post(bmToken, "bm-2", "40");
    await post(ownerToken, "owner-3", "50");
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  const api = () => request(handle.app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it("OWNER list returns audit rows newest-first", async () => {
    const res = await api().get("/api/v1/audit").set(bearer(ownerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(5);
    const ts = res.body.data.map((r: { createdAt: string }) => new Date(r.createdAt).getTime());
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i - 1]).toBeGreaterThanOrEqual(ts[i]);
    }
  });

  it("entityType filter narrows results", async () => {
    const res = await api()
      .get("/api/v1/audit?entityType=expense&limit=200")
      .set(bearer(ownerToken));
    for (const row of res.body.data) {
      expect(row.entityType).toBe("expense");
    }
  });

  it("actorId filter narrows to one user", async () => {
    const res = await api()
      .get(`/api/v1/audit?actorId=${bmUserId}&limit=200`)
      .set(bearer(ownerToken));
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    for (const row of res.body.data) {
      expect(row.actorId).toBe(bmUserId);
    }
  });

  it("Cursor pagination yields a non-overlapping next page", async () => {
    const first = await api().get("/api/v1/audit?limit=2").set(bearer(ownerToken));
    expect(first.body.data).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await api()
      .get(`/api/v1/audit?limit=2&cursor=${first.body.nextCursor}`)
      .set(bearer(ownerToken));
    expect(second.body.data.length).toBeGreaterThan(0);
    const firstIds = first.body.data.map((r: { id: string }) => r.id);
    for (const row of second.body.data) {
      expect(firstIds).not.toContain(row.id);
    }
  });

  it("from/to filter narrows by createdAt", async () => {
    // Tomorrow → expect no rows.
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const tomorrowIso = tomorrow.toISOString().slice(0, 10);
    const res = await api()
      .get(`/api/v1/audit?from=${tomorrowIso}`)
      .set(bearer(ownerToken));
    expect(res.body.data).toHaveLength(0);
  });

  it("BRANCH_MANAGER list is restricted to branch-scoped entityTypes", async () => {
    const res = await api().get("/api/v1/audit?limit=200").set(bearer(bmToken));
    expect(res.status).toBe(200);
    const allowed = new Set(["customer_order", "expense", "inventory_movement"]);
    for (const row of res.body.data) {
      expect(allowed.has(row.entityType)).toBe(true);
    }
  });

  it("BRANCH_MANAGER cannot use /audit/by-actor", async () => {
    const res = await api()
      .get(`/api/v1/audit/by-actor/${bmUserId}`)
      .set(bearer(bmToken));
    expect(res.status).toBe(403);
  });

  it("OWNER /audit/by-actor returns the actor's rows only", async () => {
    const res = await api()
      .get(`/api/v1/audit/by-actor/${bmUserId}`)
      .set(bearer(ownerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    for (const row of res.body.data) {
      expect(row.actorId).toBe(bmUserId);
    }
  });
});
