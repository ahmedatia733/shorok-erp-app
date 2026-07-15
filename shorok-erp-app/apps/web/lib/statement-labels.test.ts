import { statementRowLabel } from "./statement-labels";

describe("statementRowLabel", () => {
  it("12) labels a sales-invoice row as فاتورة مبيعات — SI-.. (not مديونية)", () => {
    const l = statementRowLabel({ sourceType: "SALES_INVOICE", reference: "SI-15", description: "مديونية م / أحمد - SI-15" });
    expect(l).toBe("فاتورة مبيعات — SI-15");
    expect(l).not.toContain("مديونية");
  });

  it("labels a purchase-invoice row", () => {
    expect(statementRowLabel({ sourceType: "PURCHASE_INVOICE", reference: "PI-9" })).toBe("فاتورة مشتريات — PI-9");
  });

  it("13) labels receipt voucher / payment / keeps manual description", () => {
    expect(statementRowLabel({ sourceType: "RECEIPT_VOUCHER", reference: "RV-3" })).toBe("سند قبض — RV-3");
    expect(statementRowLabel({ sourceType: "PAYMENT", reference: null })).toBe("سند صرف");
    expect(statementRowLabel({ sourceType: "MANUAL", description: "تسوية يدوية" })).toBe("تسوية يدوية");
    expect(statementRowLabel({ sourceType: null, description: "قيد حر" })).toBe("قيد حر");
  });

  it("prefixes reversals with عكس and keeps the source label", () => {
    expect(statementRowLabel({ sourceType: "SALES_INVOICE", reference: "SI-15", isReversal: true })).toBe("عكس فاتورة مبيعات — SI-15");
    expect(statementRowLabel({ sourceType: "MANUAL", description: "تسوية", isReversal: true })).toBe("عكس — تسوية");
  });
});
