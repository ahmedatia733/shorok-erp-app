import { confirmErrorMessageAr } from "./purchase-confirm-error";

const withReason = (reason: string) => ({ payload: { details: { reason } } });

describe("confirmErrorMessageAr", () => {
  it("maps inventory_account_required", () => {
    expect(confirmErrorMessageAr(withReason("inventory_account_required"))).toBe(
      "يجب اختيار حساب المخزون قبل ترحيل الفاتورة.",
    );
  });
  it("maps tax_account_required_when_tax_exists (the PI-2026-0016 case)", () => {
    expect(
      confirmErrorMessageAr(withReason("tax_account_required_when_tax_exists")),
    ).toBe("يجب اختيار حساب ضريبة المشتريات لأن الفاتورة تحتوي على ضريبة.");
  });
  it("maps unbalanced_journal_entry", () => {
    expect(confirmErrorMessageAr(withReason("unbalanced_journal_entry"))).toBe(
      "لا يمكن ترحيل الفاتورة لأن القيد المحاسبي غير متوازن.",
    );
  });
  it("maps a Zod issue on apAccountId to the suppliers-account message", () => {
    const err = { payload: { details: { issues: [{ path: ["apAccountId"] }] } } };
    expect(confirmErrorMessageAr(err)).toBe("يجب اختيار حساب الموردين قبل ترحيل الفاتورة.");
  });
  it("falls back to the server's Arabic message when reason is unknown", () => {
    const err = { payload: { message_ar: "رسالة الخادم", details: { reason: "something_else" } } };
    expect(confirmErrorMessageAr(err)).toBe("رسالة الخادم");
  });
  it("returns a generic message for a non-API error", () => {
    expect(confirmErrorMessageAr(new Error("network"))).toMatch(/تعذر تأكيد الفاتورة/);
  });
});
