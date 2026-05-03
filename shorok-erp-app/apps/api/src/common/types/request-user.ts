import type { Role, UserStatus } from "@shorok/shared";

/**
 * Shape of `request.user` after JwtAuthGuard runs. The guard loads a fresh
 * row from the DB so role/status/allowed_branches are authoritative — clients
 * cannot influence them by tampering with the JWT payload.
 */
export interface AuthenticatedUser {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: Role;
  status: UserStatus;
  allowedBranches: string[];
}
