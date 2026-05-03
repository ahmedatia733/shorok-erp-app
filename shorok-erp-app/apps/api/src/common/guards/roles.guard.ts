import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Role } from "@shorok/shared";
import { ROLES_KEY } from "../decorators/roles.decorator";
import { ForbiddenError } from "../errors/api-errors";
import type { AuthenticatedUser } from "../types/request-user";

/**
 * Enforces @Roles(...). OWNER bypasses every role check (highest privilege).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as AuthenticatedUser | undefined;
    if (!user) throw new ForbiddenError();

    if (user.role === "OWNER") return true;
    if (required.includes(user.role)) return true;

    throw new ForbiddenError({ requiredRoles: required, actualRole: user.role });
  }
}
