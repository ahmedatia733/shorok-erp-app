/**
 * Maps a purchase-invoice confirm failure to a clear Arabic message
 * (Phase 1 stabilization). The backend returns typed validation reasons;
 * the UI must surface them, not hide them behind a generic message.
 *
 * Duck-typed on purpose so it stays trivially unit-testable in node without
 * importing the browser API client.
 */

const REASON_MESSAGES: Record<string, string> = {
  inventory_account_required: "يجب اختيار حساب المخزون قبل ترحيل الفاتورة.",
  tax_account_required_when_tax_exists:
    "يجب اختيار حساب ضريبة المشتريات لأن الفاتورة تحتوي على ضريبة.",
  unbalanced_journal_entry: "لا يمكن ترحيل الفاتورة لأن القيد المحاسبي غير متوازن.",
  invoice_not_draft: "لا يمكن ترحيل الفاتورة لأنها ليست في حالة مسودة.",
};

const GENERIC = "تعذر تأكيد الفاتورة. تأكد من اختيار الحسابات المطلوبة وحاول مجدداً.";

interface ErrorLike {
  payload?: {
    message_ar?: string;
    details?: {
      reason?: string;
      issues?: Array<{ path?: unknown }>;
    };
  };
}

function asErrorLike(err: unknown): ErrorLike | null {
  if (err && typeof err === "object" && "payload" in err) return err as ErrorLike;
  return null;
}

/** True when a Zod validation issue references the apAccountId field. */
function missingApAccount(e: ErrorLike): boolean {
  const issues = e.payload?.details?.issues;
  if (!Array.isArray(issues)) return false;
  return issues.some((i) => {
    const p = i?.path;
    if (Array.isArray(p)) return p.includes("apAccountId");
    return String(p ?? "").includes("apAccountId");
  });
}

export function confirmErrorMessageAr(err: unknown): string {
  const e = asErrorLike(err);
  if (!e) return GENERIC;

  const reason = e.payload?.details?.reason;
  if (reason && REASON_MESSAGES[reason]) return REASON_MESSAGES[reason];

  if (missingApAccount(e)) return "يجب اختيار حساب الموردين قبل ترحيل الفاتورة.";

  // Fall back to the server's own Arabic message before the generic one.
  if (e.payload?.message_ar) return e.payload.message_ar;
  return GENERIC;
}
