/**
 * T036 — Audit atomicity test.
 *
 * Constitution Principle III says the audit row and the action it describes
 * MUST commit together. We prove it by overriding AuditService.write to
 * throw on the LOGIN audit. The login flow updates `users.last_login_at`
 * inside the same transaction as the audit write; if rollback is correct,
 * `last_login_at` should NOT advance even though the password was valid.
 */
import request from "supertest";
import { AuditService } from "../../src/modules/audit/audit.service";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("audit atomicity", () => {
  let handle: TestApp;

  beforeAll(async () => {
    handle = await buildTestApp((builder) =>
      builder.overrideProvider(AuditService).useValue({
        write: async () => {
          throw new Error("forced audit failure");
        },
      }),
    );
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  it("rolls back the action when AuditService.write throws", async () => {
    const before = await handle.prisma.user.findUniqueOrThrow({
      where: { id: handle.ownerId },
    });
    expect(before.lastLoginAt).toBeNull();

    const res = await request(handle.app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ phone: handle.ownerPhone, password: handle.ownerPassword });

    // The forced audit failure should propagate as a 500.
    expect(res.status).toBe(500);

    const after = await handle.prisma.user.findUniqueOrThrow({
      where: { id: handle.ownerId },
    });
    // Critical: lastLoginAt must NOT have been written, because the audit
    // write is part of the same Prisma transaction.
    expect(after.lastLoginAt).toBeNull();

    // No LOGIN audit row was committed, either.
    const auditCount = await handle.prisma.auditLog.count({
      where: { actorId: handle.ownerId, action: "LOGIN" },
    });
    expect(auditCount).toBe(0);
  });
});
