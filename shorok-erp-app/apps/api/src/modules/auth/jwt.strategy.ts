import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { PrismaService } from "../../prisma/prisma.service";
import { TokenExpiredError, UserDisabledError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";

export interface JwtPayload {
  sub: string;
  // Carry role for non-DB-hitting checks; the guard re-loads the row from
  // the DB so this is informational only.
  role: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>("JWT_ACCESS_SECRET"),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { branchAccesses: { select: { branchId: true } } },
    });

    if (!user) throw new TokenExpiredError();
    if (user.status === "DISABLED") throw new UserDisabledError();

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
}
