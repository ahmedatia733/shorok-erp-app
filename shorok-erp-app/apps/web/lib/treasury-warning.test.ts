import { parseTreasuryWarning } from "./treasury-warning";
import { ApiClientError } from "./api-client";

const warnPayload = {
  code: "treasury_negative_balance_warning",
  message_ar: "تحذير",
  message_en: "warning",
  details: {
    treasuryAccountId: "acc-1", accountCode: "1211", accountName: "خزينة", treasuryType: "CASH",
    currentBalance: "1000.00", operationDebit: "0.00", operationCredit: "1500.00", projectedBalance: "-500.00",
    acknowledgementRequired: true,
  },
};

describe("parseTreasuryWarning", () => {
  it("extracts the warning details from a treasury_negative_balance_warning error", () => {
    const w = parseTreasuryWarning(new ApiClientError(409, warnPayload));
    expect(w).not.toBeNull();
    expect(w!.treasuryAccountId).toBe("acc-1");
    expect(w!.projectedBalance).toBe("-500.00");
    expect(w!.treasuryType).toBe("CASH");
  });

  it("returns null for a different ApiClientError (real failure)", () => {
    expect(parseTreasuryWarning(new ApiClientError(409, { code: "validation_failed", message_ar: "x", message_en: "x" }))).toBeNull();
  });

  it("returns null for a non-ApiClientError", () => {
    expect(parseTreasuryWarning(new Error("boom"))).toBeNull();
    expect(parseTreasuryWarning(null)).toBeNull();
    expect(parseTreasuryWarning(undefined)).toBeNull();
  });

  it("returns null when the warning code has no usable details", () => {
    expect(parseTreasuryWarning(new ApiClientError(409, { code: "treasury_negative_balance_warning", message_ar: "x", message_en: "x" }))).toBeNull();
  });
});
