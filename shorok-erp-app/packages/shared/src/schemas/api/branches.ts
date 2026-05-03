import { z } from "zod";

export const CreateBranchRequestSchema = z.object({
  nameAr: z.string().min(1).max(120),
  nameEn: z.string().min(1).max(120),
  location: z.string().max(240).optional(),
});
export type CreateBranchRequest = z.infer<typeof CreateBranchRequestSchema>;

export const UpdateBranchRequestSchema = CreateBranchRequestSchema.partial();
export type UpdateBranchRequest = z.infer<typeof UpdateBranchRequestSchema>;
