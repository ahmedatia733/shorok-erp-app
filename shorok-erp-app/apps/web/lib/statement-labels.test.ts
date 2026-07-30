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

  it("labels a SALES_RETURN explicitly (not the raw customer-credit note)", () => {
    const row = { sourceType: "SALES_RETURN", reference: "SR-2", description: "رصيد دائن للعميل - SR-2" };
    expect(statementRowLabel(row)).toBe("مردود فاتورة مبيعات رقم 2");
    expect(statementRowLabel(row)).not.toContain("رصيد دائن للعميل");
    expect(statementRowLabel(row, "en")).toBe("Sales Invoice Return No. 2");
  });

  it("labels a PURCHASE_RETURN explicitly in both locales", () => {
    expect(statementRowLabel({ sourceType: "PURCHASE_RETURN", reference: "PR-3" })).toBe("مردود فاتورة مشتريات رقم 3");
    expect(statementRowLabel({ sourceType: "PURCHASE_RETURN", reference: "PR-3" }, "en")).toBe("Purchase Invoice Return No. 3");
  });

  it("falls back to the return label without a number when the reference is missing", () => {
    expect(statementRowLabel({ sourceType: "SALES_RETURN", reference: null })).toBe("مردود فاتورة مبيعات");
  });

  it("prefixes a reversed return", () => {
    expect(statementRowLabel({ sourceType: "SALES_RETURN", reference: "SR-2", isReversal: true })).toBe("عكس مردود فاتورة مبيعات رقم 2");
  });

  it("localizes non-return documents in English", () => {
    expect(statementRowLabel({ sourceType: "SALES_INVOICE", reference: "SI-15" }, "en")).toBe("Sales Invoice — SI-15");
    expect(statementRowLabel({ sourceType: "RECEIPT_VOUCHER", reference: "RV-3" }, "en")).toBe("Receipt Voucher — RV-3");
  });
});
