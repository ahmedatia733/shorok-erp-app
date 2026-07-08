/**
 * Phase 2 — configuration & period endpoints (T017/T018/T019/T024).
 * Proves permission gating, versioned config creation, audit, and the
 * effective-date resolver.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";
import { EffectiveConfigService } from "../../src/modules/configuration/effective-config.service";

describe("configuration & periods (Phase 2)", () => {
  let handle: TestApp;
  let ownerToken: string;
  let accountantToken: string;
  let viewerToken: string;
  let expenseAccountId: string;

  const login = (phone: string, password: string) =>
    request(handle.app.getHttpServer()).post("/api/v1/auth/login").send({ phone, password }).then((r) => r.body.accessToken as string);

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    await handle.prisma.user.create({ data: { name: "Acc", phone: "+201700020002", passwordHash, role: "ACCOUNTANT", status: "ACTIVE" } });
    await handle.prisma.user.create({ data: { name: "View", phone: "+201700030003", passwordHash, role: "VIEWER", status: "ACTIVE" } });

    ownerToken = await login(handle.ownerPhone, "Pwd@2026!");
    accountantToken = await login("+201700020002", "Pwd@2026!");
    viewerToken = await login("+201700030003", "Pwd@2026!");

    const acc = await handle.prisma.account.create({
      data: { code: "C5001", nameAr: "مصروف اختبار", nameEn: "Test expense", category: "EXPENSE", accountType: "EXPENSE", isLeaf: true, active: true },
    });
    expenseAccountId = acc.id;
  });

  afterAll(async () => teardownTestApp(handle));

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  // ── Periods ────────────────────────────────────────────────────────────────
  it("ACCOUNTANT can create a period; VIEWER cannot", async () => {
    const ok = await request(handle.app.getHttpServer()).post("/api/v1/settings/periods").set(auth(accountantToken)).send({ year: 2026, month: 9 });
    expect(ok.status).toBeLessThan(300);
    const denied = await request(handle.app.getHttpServer()).post("/api/v1/settings/periods").set(auth(viewerToken)).send({ year: 2026, month: 10 });
    expect(denied.status).toBe(403);
  });

  it("only OWNER can reopen a closed period", async () => {
    const created = await request(handle.app.getHttpServer()).post("/api/v1/settings/periods").set(auth(accountantToken)).send({ year: 2026, month: 11 });
    const id = created.body.id;
    await request(handle.app.getHttpServer()).post(`/api/v1/settings/periods/${id}/close`).set(auth(accountantToken)).send({});
    const accReopen = await request(handle.app.getHttpServer()).post(`/api/v1/settings/periods/${id}/reopen`).set(auth(accountantToken)).send({ reason: "x" });
    expect(accReopen.status).toBe(403);
    const ownerReopen = await request(handle.app.getHttpServer()).post(`/api/v1/settings/periods/${id}/reopen`).set(auth(ownerToken)).send({ reason: "correction" });
    expect(ownerReopen.status).toBeLessThan(300);
    expect(ownerReopen.body.status).toBe("OPEN");
    // audited
    const audit = await handle.prisma.auditLog.findFirst({ where: { entityType: "financial_period", entityId: id, action: "UPDATE" } });
    expect(audit).not.toBeNull();
  });

  // ── Posting profile (OWNER only, versioned) ────────────────────────────────
  it("only OWNER can create a posting profile version; ACCOUNTANT is blocked", async () => {
    const denied = await request(handle.app.getHttpServer()).post("/api/v1/settings/posting-profiles").set(auth(accountantToken)).send({ effectiveFrom: "2026-01-01" });
    expect(denied.status).toBe(403);
    const ok = await request(handle.app.getHttpServer()).post("/api/v1/settings/posting-profiles").set(auth(ownerToken)).send({ effectiveFrom: "2026-01-01", inventoryAccountId: expenseAccountId });
    expect(ok.status).toBeLessThan(300);
  });

  // ── Tax profile versioning + effective-date resolver ───────────────────────
  it("tax profile resolves by effective date (versioned, non-retroactive)", async () => {
    await request(handle.app.getHttpServer()).post("/api/v1/settings/tax-profiles").set(auth(ownerToken)).send({ nameKey: "vat", rate: "14.00", effectiveFrom: "2026-01-01" });
    await request(handle.app.getHttpServer()).post("/api/v1/settings/tax-profiles").set(auth(accountantToken)).send({ nameKey: "vat", rate: "15.00", effectiveFrom: "2026-08-01" });

    const resolver = handle.app.get(EffectiveConfigService);
    const july = await resolver.taxProfileAsOf("2026-07-15");
    const august = await resolver.taxProfileAsOf("2026-08-15");
    expect(july?.rate.toString()).toBe("14");
    expect(august?.rate.toString()).toBe("15");
  });

  // ── Expense category ───────────────────────────────────────────────────────
  it("ACCOUNTANT can create an expense category mapped to an account (audited)", async () => {
    const res = await request(handle.app.getHttpServer()).post("/api/v1/settings/expense-categories").set(auth(accountantToken)).send({ nameAr: "نقل", nameEn: "Transport", accountId: expenseAccountId, taxableDefault: false });
    expect(res.status).toBeLessThan(300);
    const audit = await handle.prisma.auditLog.findFirst({ where: { entityType: "expense_category", entityId: res.body.id } });
    expect(audit).not.toBeNull();
  });

  // ── Permission matrix ──────────────────────────────────────────────────────
  it("exposes the permission matrix", async () => {
    const res = await request(handle.app.getHttpServer()).get("/api/v1/settings/permissions").set(auth(viewerToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const rows = res.body as Array<{ action: string; roles: string[] }>;
    expect(rows.find((r) => r.action === "period.reopen")?.roles).toEqual([]); // OWNER only
  });
});
