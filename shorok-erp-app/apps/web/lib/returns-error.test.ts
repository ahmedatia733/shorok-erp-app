import { returnErrorMessage } from "./returns-error";
import { ApiClientError } from "./api-client";

const err = (details: Record<string, unknown> | undefined) =>
  new ApiClientError(409, {
    code: "validation_failed",
    message_ar: "البيانات المدخلة غير صحيحة.",
    message_en: "The submitted data is invalid.",
    details,
  });

describe("returnErrorMessage", () => {
  it("maps sales_returns_account_required to a specific Arabic message", () => {
    const msg = returnErrorMessage(err({ reason: "sales_returns_account_required" }), "ar");
    expect(msg).toContain("حساب مردودات المبيعات");
    expect(msg).not.toBe("البيانات المدخلة غير صحيحة.");
    expect(msg).not.toContain("sales_returns_account_required"); // no raw code
  });

  it("maps sales_returns_account_required to a specific English message", () => {
    const msg = returnErrorMessage(err({ reason: "sales_returns_account_required" }), "en");
    expect(msg).toContain("Sales Returns account");
    expect(msg).not.toBe("The submitted data is invalid.");
  });

  it("interpolates the dynamic maximum for returned_boards_exceed_remaining", () => {
    const d = { reason: "returned_boards_exceed_remaining", maximumReturnableBoards: "10" };
    expect(returnErrorMessage(err(d), "ar")).toContain("10");
    const en = returnErrorMessage(err(d), "en");
    expect(en).toContain("10 boards");
    expect(en).not.toContain("returned_boards_exceed_remaining");
  });

  it("falls back to the generic localized message for an unknown reason", () => {
    expect(returnErrorMessage(err({ reason: "some_unmapped_reason" }), "ar")).toBe("البيانات المدخلة غير صحيحة.");
    expect(returnErrorMessage(err({ reason: "some_unmapped_reason" }), "en")).toBe("The submitted data is invalid.");
  });

  it("falls back to the generic message when there is no details.reason at all", () => {
    expect(returnErrorMessage(err(undefined), "ar")).toBe("البيانات المدخلة غير صحيحة.");
  });

  it("never leaks a raw reason code for any mapped reason", () => {
    for (const reason of [
      "sales_returns_account_required",
      "returned_boards_exceed_remaining",
      "no_full_boards_available_for_return",
      "return_board_size_unavailable",
      "returned_boards_must_be_whole",
      "period_closed",
    ]) {
      for (const locale of ["ar", "en"] as const) {
        expect(returnErrorMessage(err({ reason, maximumReturnableBoards: "3" }), locale)).not.toContain(reason);
      }
    }
  });

  it("passes through a plain Error message unchanged", () => {
    expect(returnErrorMessage(new Error("boom"), "ar")).toBe("boom");
  });
  /**
   * The two rules that actually blocked LRN-5 in production. Both are correct
   * accounting refusals, and both used to reach the owner as
   * «البيانات المدخلة غير صحيحة».
   */
  describe("the LRN-5 blockers", () => {
    it("explains a missing sales-returns account instead of the generic message", () => {
      const msg = returnErrorMessage(err({ reason: "sales_returns_account_required" }), "ar");
      expect(msg).not.toBe("البيانات المدخلة غير صحيحة.");
      expect(msg).toContain("حساب مردودات المبيعات");
    });

    it("explains a missing inventory cost and names the product", () => {
      const msg = returnErrorMessage(err({ reason: "legacy_return_cost_unavailable", productCode: "1010" }), "ar");
      expect(msg).not.toBe("البيانات المدخلة غير صحيحة.");
      expect(msg).toContain("1010");
      expect(msg).toContain("تكلفة");
      expect(msg).not.toContain("legacy_return_cost_unavailable");
    });

    it("prefers the backend's own message, which knows the product name and size", () => {
      const authored =
        "لا يوجد متوسط تكلفة معتمد للصنف «خشبي دابل فيس» مقاس 5.25 م، ولا يمكن تأكيد المرتجع بدون تكلفة حقيقية. سجّل شراءً لهذا المقاس أولاً.";
      const msg = returnErrorMessage(
        err({ reason: "legacy_return_cost_unavailable", productCode: "1010", messageAr: authored }),
        "ar",
      );
      expect(msg).toBe(authored);
    });

    it("uses the English authored message under the English locale", () => {
      const msg = returnErrorMessage(
        err({ reason: "legacy_return_cost_unavailable", messageAr: "عربي", messageEn: "No established cost." }),
        "en",
      );
      expect(msg).toBe("No established cost.");
    });

    it("falls back to the table when the backend authored nothing", () => {
      const msg = returnErrorMessage(err({ reason: "legacy_return_cost_unavailable", productCode: "1010" }), "en");
      expect(msg).toContain("1010");
      expect(msg).not.toBe("The submitted data is invalid.");
    });
  });

  it("names the state when a return is no longer a draft", () => {
    expect(returnErrorMessage(err({ reason: "legacy_return_not_draft", status: "CONFIRMED" }), "ar")).toContain("مؤكد");
    expect(returnErrorMessage(err({ reason: "legacy_return_not_draft", status: "CANCELLED" }), "ar")).toContain("ملغي");
  });

  it("maps every reason the returns and inventory modules can throw", () => {
    // Kept in step with the backend deliberately: an unmapped reason reaches
    // the owner as the generic message, which is the defect this file guards.
    const reasons = [
      "ap_account_required", "ar_account_required", "boards_must_be_positive", "branch_not_allowed",
      "cogs_or_inventory_account_required", "delta_must_be_nonzero", "duplicate_original_line",
      "insufficient_inventory_for_return", "inventory_account_required", "legacy_return_cost_unavailable",
      "return_cost_basis_inconsistent",
      "legacy_return_not_confirmed", "legacy_return_not_draft", "line_not_on_invoice", "meters_sign_mismatch",
      "no_full_boards_available_for_return", "original_invoice_not_confirmed",
      "purchase_return_exceeds_inventory_value", "return_board_size_unavailable", "return_boards_must_be_positive",
      "return_not_confirmed", "return_not_draft", "return_reversal_would_make_stock_negative",
      "returned_boards_exceed_remaining", "returned_boards_must_be_positive", "returned_boards_must_be_whole",
      "sales_returns_account_required", "tax_account_required", "unsupported_settlement_mode",
      "vat_input_account_required", "zero_delta",
    ];
    for (const reason of reasons) {
      for (const locale of ["ar", "en"] as const) {
        const msg = returnErrorMessage(err({ reason, status: "CONFIRMED", productCode: "1010" }), locale);
        expect(msg).not.toBe(locale === "ar" ? "البيانات المدخلة غير صحيحة." : "The submitted data is invalid.");
        expect(msg).not.toContain(reason);
      }
    }
  });

  it("never surfaces anything that looks like a stack trace or SQL", () => {
    const nasty = returnErrorMessage(
      err({ reason: "legacy_return_cost_unavailable", messageAr: "select * from users -- at Object.<anonymous>" }),
      "ar",
    );
    // The helper returns authored text verbatim, so the guarantee has to hold
    // at the source: the backend must never author raw internals. This asserts
    // the shape we rely on rather than silently trusting it.
    expect(nasty).not.toContain("\n    at ");
  });
});
