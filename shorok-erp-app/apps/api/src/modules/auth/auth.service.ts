import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { createHash, randomBytes } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";
import {
  InvalidCredentialsError,
  RefreshInvalidError,
  UserDisabledError,
} from "../../common/errors/api-errors";
import { normalizePhoneE164 } from "./phone-normalize";
import type { LoginRequest, LoginResponse, MeResponse } from "@shorok/shared";

interface IssueTokensResult {
  accessToken: string;
  expiresInSec: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginRequest, userAgent?: string): Promise<IssueTokensResult> {
    const phone = normalizePhoneE164(input.phone);
    if (!phone) throw new InvalidCredentialsError();

    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) throw new InvalidCredentialsError();
    if (user.status === "DISABLED") throw new UserDisabledError();

    const passwordOk = await bcrypt.compare(input.password, user.passwordHash);
    if (!passwordOk) throw new InvalidCredentialsError();

    const tokens = await this.issueTokens(user.id, user.role, userAgent);

    // Login is audited and last_login_at is updated atomically with the
    // refresh-token row creation.
    await this.prisma.runInTransaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "LOGIN",
        entityType: "user",
        entityId: user.id,
        summaryAr: `سجّل المستخدم ${user.name} الدخول.`,
        summaryEn: `User ${user.name} signed in.`,
      });
    });

    return tokens;
  }

  async refresh(rawRefreshToken: string, userAgent?: string): Promise<IssueTokensResult> {
    if (!rawRefreshToken) throw new RefreshInvalidError();
    const tokenHash = sha256(rawRefreshToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
      throw new RefreshInvalidError();
    }
    if (stored.user.status === "DISABLED") throw new UserDisabledError();

    // Rotate: revoke the old refresh row, issue a new pair.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(stored.userId, stored.user.role, userAgent);
  }

  async logout(rawRefreshToken: string | undefined, actorId: string): Promise<void> {
    if (rawRefreshToken) {
      const tokenHash = sha256(rawRefreshToken);
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await this.prisma.runInTransaction(async (tx) => {
      await this.audit.write({
        tx,
        actorId,
        action: "LOGOUT",
        entityType: "user",
        entityId: actorId,
        summaryAr: "سجّل المستخدم الخروج.",
        summaryEn: "User signed out.",
      });
    });
  }

  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { branchAccesses: { select: { branchId: true } } },
    });
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      status: user.status,
      allowedBranches: user.branchAccesses.map((b) => b.branchId),
    };
  }

  private async issueTokens(
    userId: string,
    role: string,
    userAgent?: string,
  ): Promise<IssueTokensResult> {
    const accessTtl = this.config.getOrThrow<string>("JWT_ACCESS_TTL");
    const refreshTtlMs = parseDurationToMs(this.config.getOrThrow<string>("JWT_REFRESH_TTL"));
    const accessSecret = this.config.getOrThrow<string>("JWT_ACCESS_SECRET");

    const accessToken = await this.jwt.signAsync(
      { sub: userId, role },
      { secret: accessSecret, expiresIn: accessTtl },
    );

    const rawRefresh = randomBytes(48).toString("hex");
    const refreshExpiresAt = new Date(Date.now() + refreshTtlMs);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(rawRefresh),
        expiresAt: refreshExpiresAt,
        userAgent: userAgent?.slice(0, 240) ?? null,
      },
    });

    return {
      accessToken,
      expiresInSec: parseDurationToMs(accessTtl) / 1000,
      refreshToken: rawRefresh,
      refreshExpiresAt,
    };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Parse JWT-ish duration strings like "15m", "7d", "30s". Falls back to ms if pure number. */
function parseDurationToMs(input: string): number {
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(input.trim());
  if (!m || !m[1]) {
    const n = Number(input);
    if (!Number.isFinite(n)) throw new Error(`Invalid duration: ${input}`);
    return n;
  }
  const value = Number(m[1]);
  const unit = m[2] ?? "s";
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * (multipliers[unit] ?? 1000);
}
