import { z } from "zod";
import { RoleEnum, UserStatusEnum } from "../../enums";
import { PhoneE164Schema, UuidSchema } from "../primitives";

export const LoginRequestSchema = z.object({
  phone: PhoneE164Schema,
  password: z.string().min(8).max(120),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  expiresInSec: z.number().int().positive(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const RefreshResponseSchema = LoginResponseSchema;
export type RefreshResponse = LoginResponse;

export const MeResponseSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  phone: PhoneE164Schema,
  email: z.string().email().nullable(),
  role: RoleEnum,
  status: UserStatusEnum,
  allowedBranches: z.array(UuidSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
