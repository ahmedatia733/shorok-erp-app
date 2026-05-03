import { z } from "zod";
import { UuidSchema } from "../primitives";

export const AuditQuerySchema = z.object({
  entityType: z.string().min(1).max(60).optional(),
  entityId: UuidSchema.optional(),
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export const AuditByActorQuerySchema = z.object({
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditByActorQuery = z.infer<typeof AuditByActorQuerySchema>;
