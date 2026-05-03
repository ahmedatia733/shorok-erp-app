import { SetMetadata } from "@nestjs/common";
import type { Role } from "@shorok/shared";

export const ROLES_KEY = "requiredRoles";

/** Restrict a route to one or more roles. OWNER bypasses everything else. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
