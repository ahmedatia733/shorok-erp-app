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

/**
 * Validation for the create-treasury form. Returns a (localized) error message
 * or null. Messages default to Arabic; callers pass localized strings.
 */
export function validateTreasuryForm(
  v: { nameAr: string; branchId: string },
  msg: { nameRequired: string; branchRequired: string } = { nameRequired: "اسم الخزنة بالعربية مطلوب.", branchRequired: "اختر الفرع." },
): string | null {
  if (!v.nameAr.trim()) return msg.nameRequired;
  if (!v.branchId) return msg.branchRequired;
  return null;
}

/**
 * Validation for the treasury-transfer form. Returns a (localized) error message
 * or null. Messages default to Arabic; callers pass localized strings.
 */
export function validateTransferForm(
  v: { sourceTreasuryId: string; destinationTreasuryId: string; amount: string },
  msg: { both: string; same: string; amount: string } = { both: "اختر خزنة المصدر والوجهة.", same: "لا يمكن التحويل إلى نفس الخزنة.", amount: "أدخل مبلغاً أكبر من صفر." },
): string | null {
  if (!v.sourceTreasuryId || !v.destinationTreasuryId) return msg.both;
  if (v.sourceTreasuryId === v.destinationTreasuryId) return msg.same;
  if (!v.amount || Number(v.amount) <= 0) return msg.amount;
  return null;
}
