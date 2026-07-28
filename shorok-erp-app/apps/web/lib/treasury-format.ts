import type { TreasuryRow } from "./treasuries-client";

/** Status → Arabic label + badge variant for treasury transfers. */
export function statusBadge(status: string): { label: string; variant: "neutral" | "success" | "warning" } {
  if (status === "CONFIRMED") return { label: "مؤكد", variant: "success" };
  if (status === "CANCELLED") return { label: "ملغي", variant: "neutral" };
  return { label: "مسودة", variant: "warning" };
}

export function money(v: string | number): string {
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Selector option label: name (code) — balance. */
export function treasuryOptionLabel(t: Pick<TreasuryRow, "nameAr" | "code" | "balance">): string {
  return `${t.nameAr} (${t.code}) — ${money(t.balance)}`;
}

/** A transaction selector must offer ONLY active treasuries. */
export function selectableTreasuries<T extends { active: boolean }>(rows: T[]): T[] {
  return rows.filter((t) => t.active);
}

/** Arabic validation for the create-treasury form. Returns an error message or null. */
export function validateTreasuryForm(v: { nameAr: string; branchId: string }): string | null {
  if (!v.nameAr.trim()) return "اسم الخزنة بالعربية مطلوب.";
  if (!v.branchId) return "اختر الفرع.";
  return null;
}

/** Arabic validation for the treasury-transfer form. Returns an error message or null. */
export function validateTransferForm(v: { sourceTreasuryId: string; destinationTreasuryId: string; amount: string }): string | null {
  if (!v.sourceTreasuryId || !v.destinationTreasuryId) return "اختر خزنة المصدر والوجهة.";
  if (v.sourceTreasuryId === v.destinationTreasuryId) return "لا يمكن التحويل إلى نفس الخزنة.";
  if (!v.amount || Number(v.amount) <= 0) return "أدخل مبلغاً أكبر من صفر.";
  return null;
}
