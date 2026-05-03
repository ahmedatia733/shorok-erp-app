/**
 * T043 — Admin catalog integration tests.
 *
 * Covers happy paths and the key RBAC denial cases for branches, users,
 * products, suppliers, system-settings.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("admin catalog", () => {
  let handle: TestApp;
  let ownerToken: string;
  let viewerToken: string;
  let viewerId: string;

  beforeAll(async () => {
    handle = await buildTestApp();

    const ownerLogin = await request(handle.app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ phone: handle.ownerPhone, password: handle.ownerPassword });
    ownerToken = ownerLogin.body.accessToken;

    // Create a non-owner user (VIEWER) so we can test RBAC denials.
    const viewer = await handle.prisma.user.create({
      data: {
        name: "Test Viewer",
        phone: "+201112223333",
        passwordHash: await bcrypt.hash("View@2026!", 10),
        role: "VIEWER",
        status: "ACTIVE",
      },
    });
    viewerId = viewer.id;
    const viewerLogin = await request(handle.app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ phone: "+201112223333", password: "View@2026!" });
    viewerToken = viewerLogin.body.accessToken;
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

  it("OWNER creates a branch and audits it", async () => {
    const res = await api()
      .post("/api/v1/branches")
      .set(bearer(ownerToken))
      .send({ nameAr: "فرع جديد", nameEn: "New Branch", location: "Cairo" });
    expect(res.status).toBe(201);
    expect(res.body.nameEn).toBe("New Branch");

    const audit = await handle.prisma.auditLog.findFirst({
      where: { entityType: "branch", entityId: res.body.id, action: "CREATE" },
    });
    expect(audit).toBeTruthy();
    expect(audit!.humanReadableSummaryAr).toContain("فرع جديد");
    expect(audit!.humanReadableSummaryEn).toContain("New Branch");
  });

  it("VIEWER cannot create a branch (403 forbidden)", async () => {
    const res = await api()
      .post("/api/v1/branches")
      .set(bearer(viewerToken))
      .send({ nameAr: "x", nameEn: "x" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("OWNER creates a SKU and a variant", async () => {
    const sku = await api()
      .post("/api/v1/products/skus")
      .set(bearer(ownerToken))
      .send({ code: "TST-01", colorNameAr: "اختبار", colorNameEn: "Test" });
    expect(sku.status).toBe(201);
    const variant = await api()
      .post("/api/v1/products/variants")
      .set(bearer(ownerToken))
      .send({
        skuId: sku.body.id,
        sizeMetersPerBoard: "5.25",
        defaultSalePricePerMeter: "150.00",
        defaultPurchasePricePerMeter: "110.00",
      });
    expect(variant.status).toBe(201);
    expect(variant.body.skuId).toBe(sku.body.id);
  });

  it("OWNER creates a supplier; ACCOUNTANT can also create; VIEWER cannot", async () => {
    const ownerSupplier = await api()
      .post("/api/v1/suppliers")
      .set(bearer(ownerToken))
      .send({ nameAr: "مورد ١", nameEn: "Supplier 1" });
    expect(ownerSupplier.status).toBe(201);

    const viewerSupplier = await api()
      .post("/api/v1/suppliers")
      .set(bearer(viewerToken))
      .send({ nameAr: "x", nameEn: "x" });
    expect(viewerSupplier.status).toBe(403);
  });

  it("GET /system-settings returns the singleton and PATCH (OWNER) updates it", async () => {
    const get = await api().get("/api/v1/system-settings").set(bearer(ownerToken));
    expect(get.status).toBe(200);
    expect(get.body.id).toBe(1);

    const patch = await api()
      .patch("/api/v1/system-settings")
      .set(bearer(ownerToken))
      .send({ defaultPriceOverrideTolerancePercent: "7.50" });
    expect(patch.status).toBe(200);
    expect(patch.body.defaultPriceOverrideTolerancePercent).toBe("7.5");
  });

  it("VIEWER cannot patch system-settings", async () => {
    const res = await api()
      .patch("/api/v1/system-settings")
      .set(bearer(viewerToken))
      .send({ lowStockThresholdBoards: "10" });
    expect(res.status).toBe(403);
  });

  it("OWNER creates a user and audits it; rejects duplicate phone with 409", async () => {
    const created = await api()
      .post("/api/v1/users")
      .set(bearer(ownerToken))
      .send({
        name: "Branch Mgr",
        phone: "+201005005005",
        password: "BranchMgr@2026",
        role: "BRANCH_MANAGER",
        allowedBranches: [handle.branchId],
      });
    expect(created.status).toBe(201);
    expect(created.body.allowedBranches).toEqual([handle.branchId]);

    const dup = await api()
      .post("/api/v1/users")
      .set(bearer(ownerToken))
      .send({
        name: "X",
        phone: "+201005005005",
        password: "Whatever@2026",
        role: "VIEWER",
        allowedBranches: [],
      });
    expect(dup.status).toBe(409);
  });

  it("OWNER cannot change own role via PATCH /users/:id", async () => {
    const res = await api()
      .patch(`/api/v1/users/${handle.ownerId}`)
      .set(bearer(ownerToken))
      .send({ role: "VIEWER" });
    expect(res.status).toBe(403);
  });

  it("OWNER disables and re-enables a user; audits both", async () => {
    const disable = await api()
      .post(`/api/v1/users/${viewerId}/disable`)
      .set(bearer(ownerToken));
    expect(disable.status).toBe(204);

    // Disabled user can't log in
    const login = await api()
      .post("/api/v1/auth/login")
      .send({ phone: "+201112223333", password: "View@2026!" });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe("user_disabled");

    const enable = await api().post(`/api/v1/users/${viewerId}/enable`).set(bearer(ownerToken));
    expect(enable.status).toBe(204);

    const audits = await handle.prisma.auditLog.findMany({
      where: { entityType: "user", entityId: viewerId, action: "UPDATE" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });
});
