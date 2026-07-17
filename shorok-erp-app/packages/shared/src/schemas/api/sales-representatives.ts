import { z } from "zod";

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CreateSalesRepresentativeSchema = z.object({
  // Optional: the server generates REP-#### when omitted or blank.
  code: z.string().trim().max(20).optional(),
  nameAr: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().max(200).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  active: z.boolean().optional(),
});
export type CreateSalesRepresentative = z.infer<typeof CreateSalesRepresentativeSchema>;

export const UpdateSalesRepresentativeSchema = z.object({
  nameAr: z.string().trim().min(1).max(200).optional(),
  nameEn: z.string().trim().max(200).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  active: z.boolean().optional(),
});
export type UpdateSalesRepresentative = z.infer<typeof UpdateSalesRepresentativeSchema>;

export const SalesRepresentativeQuerySchema = z.object({
  // Free-text search over code / Arabic name / English name / phone.
  search: z.string().trim().max(120).optional(),
  // "active" | "inactive" | "all" (default all).
  status: z.enum(["active", "inactive", "all"]).optional(),
});
export type SalesRepresentativeQuery = z.infer<typeof SalesRepresentativeQuerySchema>;

export const SalesRepresentativeStatementQuerySchema = z.object({
  from: DateStr.optional(),
  to: DateStr.optional(),
  branchId: z.string().uuid().optional(),
  // Filter the combined timeline by row kind.
  type: z.enum(["all", "invoice", "journal"]).optional(),
  // Filter sales-invoice rows by status.
  invoiceStatus: z.enum(["DRAFT", "CONFIRMED", "CANCELLED", "PAID"]).optional(),
});
export type SalesRepresentativeStatementQuery = z.infer<typeof SalesRepresentativeStatementQuerySchema>;
