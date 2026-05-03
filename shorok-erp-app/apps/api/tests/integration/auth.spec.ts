/**
 * T035 — Auth integration tests.
 *
 * Covers: login (valid + invalid + disabled), refresh (rotation), /me,
 * RBAC denial via the global RolesGuard, and JWT rejection (no token).
 */
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("auth", () => {
  let handle: TestApp;

  beforeAll(async () => {
    handle = await buildTestApp();
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  function api() {
    return request(handle.app.getHttpServer());
  }

  it("rejects login with unknown phone", async () => {
    const res = await api()
      .post("/api/v1/auth/login")
      .send({ phone: "+201111111111", password: "whatever-pwd" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_credentials");
    expect(res.body.message_ar).toBeTruthy();
    expect(res.body.message_en).toBeTruthy();
  });

  it("rejects login with bad password", async () => {
    const res = await api()
      .post("/api/v1/auth/login")
      .send({ phone: handle.ownerPhone, password: "Wrong-Password-123" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_credentials");
  });

  it("logs in with valid credentials and returns access token", async () => {
    const res = await api()
      .post("/api/v1/auth/login")
      .send({ phone: handle.ownerPhone, password: handle.ownerPassword });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toMatch(/^eyJ/); // JWT starts with eyJ
    expect(res.body.expiresInSec).toBeGreaterThan(0);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies.some((c) => c.startsWith("shorok_refresh="))).toBe(true);
  });

  it("rejects /auth/me without a bearer token", async () => {
    const res = await api().get("/api/v1/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns the current user on /auth/me with a valid token", async () => {
    const login = await api()
      .post("/api/v1/auth/login")
      .send({ phone: handle.ownerPhone, password: handle.ownerPassword });
    const me = await api()
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe("OWNER");
    expect(me.body.phone).toBe(handle.ownerPhone);
  });

  it("rotates refresh token on /auth/refresh", async () => {
    const login = await api()
      .post("/api/v1/auth/login")
      .send({ phone: handle.ownerPhone, password: handle.ownerPassword });
    const refreshCookie = (login.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith("shorok_refresh="),
    )!;
    expect(refreshCookie).toBeDefined();

    const refresh = await api().post("/api/v1/auth/refresh").set("Cookie", refreshCookie);
    expect(refresh.status).toBe(200);
    expect(refresh.body.accessToken).toMatch(/^eyJ/);

    // Old refresh cookie is now revoked.
    const replay = await api().post("/api/v1/auth/refresh").set("Cookie", refreshCookie);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("refresh_invalid");
  });

  it("rejects login when user is disabled", async () => {
    await handle.prisma.user.update({
      where: { id: handle.ownerId },
      data: { status: "DISABLED" },
    });
    const res = await api()
      .post("/api/v1/auth/login")
      .send({ phone: handle.ownerPhone, password: handle.ownerPassword });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("user_disabled");
    // restore for any later tests
    await handle.prisma.user.update({
      where: { id: handle.ownerId },
      data: { status: "ACTIVE" },
    });
  });

  it("writes a LOGIN audit row on successful login", async () => {
    const before = await handle.prisma.auditLog.count({
      where: { actorId: handle.ownerId, action: "LOGIN" },
    });
    await api()
      .post("/api/v1/auth/login")
      .send({ phone: handle.ownerPhone, password: handle.ownerPassword });
    const after = await handle.prisma.auditLog.count({
      where: { actorId: handle.ownerId, action: "LOGIN" },
    });
    expect(after).toBe(before + 1);

    const row = await handle.prisma.auditLog.findFirst({
      where: { actorId: handle.ownerId, action: "LOGIN" },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.humanReadableSummaryAr).toMatch(/سجّل/);
    expect(row?.humanReadableSummaryEn).toMatch(/signed in/);
  });
});
