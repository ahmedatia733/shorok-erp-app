import type { AppLocale } from "../i18n";
import { ApiClientError } from "./api-client";

/**
 * Turns a returns API error into a SPECIFIC, localized message.
 *
 * The global API envelope carries `{ code, message_ar, message_en, details }`,
 * where every business rule is `code: "validation_failed"` with the real cause
 * in `details.reason`. `ApiClientError.localizedMessage()` only surfaces the
 * generic `message_ar/en`, so on its own the user always sees «البيانات المدخلة
 * غير صحيحة». This helper reads `details.reason` (and any dynamic values it
 * carries) and returns a precise message, falling back to the generic localized
 * message for any reason it doesn't know — the global contract is untouched.
 */

type Details = Record<string, unknown> | undefined;
const val = (d: Details, k: string) => (d && d[k] != null ? String(d[k]) : "");

const MESSAGES: Record<string, { ar: (d: Details) => string; en: (d: Details) => string }> = {
  // ── posting-account configuration ────────────────────────────────────────
  sales_returns_account_required: {
    ar: () => "لا يمكن تأكيد مردود المبيعات لأن حساب مردودات المبيعات غير مُحدد في إعدادات الترحيل المحاسبي.",
    en: () => "The sales return cannot be confirmed because the Sales Returns account is not configured in the accounting posting settings.",
  },
  ar_account_required: {
    ar: () => "لا يمكن الترحيل لأن حساب العملاء (الذمم المدينة) غير مُحدد في إعدادات الترحيل.",
    en: () => "Posting is not possible because the Accounts Receivable account is not configured in the posting settings.",
  },
  tax_account_required: {
    ar: () => "لا يمكن الترحيل لأن حساب ضريبة المبيعات (المخرجات) غير مُحدد في إعدادات الترحيل.",
    en: () => "Posting is not possible because the output VAT account is not configured in the posting settings.",
  },
  cogs_or_inventory_account_required: {
    ar: () => "لا يمكن الترحيل لأن حساب تكلفة المبيعات أو حساب المخزون غير مُحدد في إعدادات الترحيل.",
    en: () => "Posting is not possible because the COGS or Inventory account is not configured in the posting settings.",
  },
  inventory_account_required: {
    ar: () => "لا يمكن الترحيل لأن حساب المخزون غير مُحدد في إعدادات الترحيل.",
    en: () => "Posting is not possible because the Inventory account is not configured in the posting settings.",
  },
  ap_account_required: {
    ar: () => "لا يمكن الترحيل لأن حساب الموردين (الذمم الدائنة) غير مُحدد في إعدادات الترحيل.",
    en: () => "Posting is not possible because the Accounts Payable account is not configured in the posting settings.",
  },
  vat_input_account_required: {
    ar: () => "لا يمكن الترحيل لأن حساب ضريبة المشتريات (المدخلات) غير مُحدد في إعدادات الترحيل.",
    en: () => "Posting is not possible because the input VAT account is not configured in the posting settings.",
  },
  invalid_sales_returns_account: {
    ar: () => "الحساب المختار غير صالح كحساب مردودات مبيعات (يجب أن يكون حساباً فرعياً نشطاً من نوع الإيرادات).",
    en: () => "The selected account is invalid as a Sales Returns account (it must be an active leaf REVENUE account).",
  },
  // ── whole-board quantity rules ───────────────────────────────────────────
  returned_boards_exceed_remaining: {
    ar: (d) => `العدد المطلوب أكبر من المتاح. الحد الأقصى القابل للإرجاع هو ${val(d, "maximumReturnableBoards")} ألواح.`,
    en: (d) => `The requested quantity exceeds the available quantity. The maximum returnable quantity is ${val(d, "maximumReturnableBoards")} boards.`,
  },
  no_full_boards_available_for_return: {
    ar: () => "لا توجد ألواح كاملة قابلة للإرجاع لهذا السطر.",
    en: () => "There are no full boards available to return for this line.",
  },
  return_board_size_unavailable: {
    ar: () => "مقاس اللوح غير متاح في الفاتورة الأصلية، لذا لا يمكن إرجاع هذا السطر.",
    en: () => "The board size is unavailable on the original invoice, so this line cannot be returned.",
  },
  legacy_return_quantity_ambiguous: {
    ar: () => "كمية هذا السطر غير قابلة للتحديد (فاتورة قديمة)، لذا لا يمكن إرجاعه.",
    en: () => "This line's quantity cannot be determined (legacy invoice), so it cannot be returned.",
  },
  returned_boards_must_be_whole: {
    ar: () => "يجب أن يكون عدد الألواح المرتجعة عدداً صحيحاً (لا يُسمح بالكسور).",
    en: () => "The number of returned boards must be a whole number (fractions are not allowed).",
  },
  returned_boards_must_be_positive: {
    ar: () => "يجب إدخال عدد ألواح مرتجعة أكبر من صفر.",
    en: () => "Enter a number of returned boards greater than zero.",
  },
  return_boards_must_be_positive: {
    ar: () => "يجب إدخال عدد ألواح مرتجعة أكبر من صفر.",
    en: () => "Enter a number of returned boards greater than zero.",
  },
  // ── stock / value guards ─────────────────────────────────────────────────
  purchase_return_exceeds_inventory_value: {
    ar: () => "قيمة المرتجع أكبر من قيمة المخزون الحالية، لذا لا يمكن تأكيد مردود المشتريات.",
    en: () => "The return value exceeds the current inventory value, so the purchase return cannot be confirmed.",
  },
  insufficient_inventory_for_return: {
    ar: () => "المخزون المتاح غير كافٍ لتنفيذ هذا المرتجع.",
    en: () => "There is not enough available stock to process this return.",
  },
  return_reversal_would_make_stock_negative: {
    ar: () => "لا يمكن الإلغاء لأن المخزون المرتجع قد استُهلك بالفعل (سيصبح الرصيد سالباً).",
    en: () => "Cannot cancel because the returned stock has already been consumed (the balance would go negative).",
  },
  // ── state / document rules ───────────────────────────────────────────────
  original_invoice_not_confirmed: {
    ar: () => "لا يمكن إنشاء مردود لفاتورة غير مؤكدة.",
    en: () => "A return cannot be created for an unconfirmed invoice.",
  },
  line_not_on_invoice: {
    ar: () => "السطر المحدد لا ينتمي إلى الفاتورة الأصلية.",
    en: () => "The selected line does not belong to the original invoice.",
  },
  duplicate_original_line: {
    ar: () => "لا يمكن تكرار نفس سطر الفاتورة الأصلية في نفس المردود.",
    en: () => "The same original invoice line cannot appear twice in one return.",
  },
  return_not_draft: {
    ar: () => "لا يمكن تنفيذ هذا الإجراء إلا على مسودة.",
    en: () => "This action is only allowed on a draft return.",
  },
  return_not_confirmed: {
    ar: () => "لا يمكن الإلغاء إلا لمردود مؤكد.",
    en: () => "Only a confirmed return can be cancelled.",
  },
  unsupported_settlement_mode: {
    ar: () => "طريقة التسوية المحددة غير مدعومة (الرد النقدي غير متاح حالياً).",
    en: () => "The selected settlement mode is not supported (cash refund is not available yet).",
  },
  // ── financial period ─────────────────────────────────────────────────────
  period_closed: {
    ar: () => "لا يمكن الترحيل لأن الفترة المالية مغلقة.",
    en: () => "Posting is not possible because the financial period is closed.",
  },
  period_not_open: {
    ar: () => "لا يمكن الترحيل لأن الفترة المالية غير مفتوحة.",
    en: () => "Posting is not possible because the financial period is not open.",
  },
};

/** SPECIFIC localized message for a returns error, else the generic fallback. */
export function returnErrorMessage(err: unknown, locale: AppLocale): string {
  if (err instanceof ApiClientError) {
    const details = err.payload.details as Details;
    const reason = details && typeof details.reason === "string" ? details.reason : undefined;
    const m = reason ? MESSAGES[reason] : undefined;
    if (m) return locale === "ar" ? m.ar(details) : m.en(details);
    return err.localizedMessage(locale);
  }
  return err instanceof Error ? err.message : String(err);
}
