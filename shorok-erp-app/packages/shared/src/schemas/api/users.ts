import { z } from "zod";
import { RoleEnum } from "../../enums";
import { PhoneE164Schema, UuidSchema } from "../primitives";

export const CreateUserRequestSchema = z.object({
  name: z.string().min(1).max(120),
  phone: PhoneE164Schema,
  email: z.string().email().max(160).optional(),
  password: z.string().min(8).max(120),
  role: RoleEnum,
  allowedBranches: z.array(UuidSchema).default([]),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const UpdateUserRequestSchema = CreateUserRequestSchema.partial().omit({
  password: true,
});
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const PasswordResetRequestSchema = z.object({
  password: z.string().min(8).max(120),
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;
