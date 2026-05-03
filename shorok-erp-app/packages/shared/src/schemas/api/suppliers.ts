import { z } from "zod";

export const CreateSupplierRequestSchema = z.object({
  nameAr: z.string().min(1).max(160),
  nameEn: z.string().min(1).max(160),
});
export type CreateSupplierRequest = z.infer<typeof CreateSupplierRequestSchema>;

export const UpdateSupplierRequestSchema = CreateSupplierRequestSchema.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateSupplierRequest = z.infer<typeof UpdateSupplierRequestSchema>;
