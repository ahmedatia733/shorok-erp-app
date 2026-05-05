import { z } from "zod";
import { UuidSchema } from "../primitives";

export const AuditQuerySchema = z.object({
  entityType: z.string().min(1).max(60).optional(),
  entityId: UuidSchema.optional(),
  actorId: UuidSchema.optional(),
  /** ISO date (yyyy-mm-dd) — inclusive lower bound on createdAt. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** ISO date (yyyy-mm-dd) — inclusive upper bound on createdAt. */
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export const AuditByActorQuerySchema = z.object({
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditByActorQuery = z.infer<typeof AuditByActorQuerySchema>;
