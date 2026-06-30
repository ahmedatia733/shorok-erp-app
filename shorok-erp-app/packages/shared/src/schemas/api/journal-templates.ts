import { z } from "zod";

export const JournalTemplateLineInputSchema = z.object({
  accountId: z.string().uuid(),
  type: z.enum(["debit", "credit"]),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .optional(),
  note: z.string().max(300).optional(),
  sortOrder: z.number().int().optional(),
});
export type JournalTemplateLineInput = z.infer<typeof JournalTemplateLineInputSchema>;

export const CreateJournalTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  lines: z.array(JournalTemplateLineInputSchema).min(1),
});
export type CreateJournalTemplate = z.infer<typeof CreateJournalTemplateSchema>;

export const UpdateJournalTemplateSchema = CreateJournalTemplateSchema.partial();
export type UpdateJournalTemplate = z.infer<typeof UpdateJournalTemplateSchema>;
