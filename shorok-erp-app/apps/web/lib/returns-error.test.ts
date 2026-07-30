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
});
