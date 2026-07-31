import { accountingMoney, adaptiveMoney, money } from "./statement-format";

describe("adaptiveMoney", () => {
  it("drops the fraction only when it is exactly zero piasters (English)", () => {
    expect(adaptiveMoney("0", "en")).toBe("0");
    expect(adaptiveMoney("0.00", "en")).toBe("0");
    expect(adaptiveMoney("1000", "en")).toBe("1,000");
    expect(adaptiveMoney("1000.00", "en")).toBe("1,000");
    expect(adaptiveMoney("12380.00", "en")).toBe("12,380");
  });

  it("keeps real non-zero piasters (English)", () => {
    expect(adaptiveMoney("1000.50", "en")).toBe("1,000.50");
    expect(adaptiveMoney("1000.25", "en")).toBe("1,000.25");
    expect(adaptiveMoney("1000.10", "en")).toBe("1,000.10");
    expect(adaptiveMoney("12380.50", "en")).toBe("12,380.50");
  });

  it("does not round a whole value into a different amount", () => {
    expect(adaptiveMoney("12380.00", "en")).not.toContain(".");
    expect(adaptiveMoney("12380.00", "en")).toBe("12,380");
    expect(adaptiveMoney(12380, "en")).toBe("12,380");
  });

  it("uses Arabic-Indic digits for ar and still drops the zero fraction", () => {
    const whole = adaptiveMoney("12380.00", "ar");
    expect(whole).not.toBe("12,380");   // Arabic-Indic, not Latin
    expect(whole).not.toMatch(/[.,]٠٠$/); // no trailing zero-piaster fraction
    const frac = adaptiveMoney("1000.50", "ar");
    // ar-EG uses ٫ as the decimal separator with two Arabic-Indic fraction digits.
    expect(frac).toMatch(/٥٠$/);
  });

  it("accepts a string Decimal and a number", () => {
    expect(adaptiveMoney("2500.00", "en")).toBe("2,500");
    expect(adaptiveMoney(2500.75, "en")).toBe("2,500.75");
  });

  it("falls back to the two-decimal formatter for invalid input", () => {
    expect(adaptiveMoney("not-a-number", "en")).toBe(money("not-a-number", "en"));
  });
});

describe("accountingMoney (adaptive)", () => {
  it("shows a whole positive with no trailing .00", () => {
    expect(accountingMoney("1000.00", "en")).toEqual({ text: "1,000", negative: false });
    expect(accountingMoney("0", "en")).toEqual({ text: "0", negative: false });
  });

  it("keeps piasters on a positive with a real fraction", () => {
    expect(accountingMoney("1234.5", "en").text).toBe("1,234.50");
  });

  it("wraps a whole negative in parentheses without .00", () => {
    const r = accountingMoney("-12380", "en");
    expect(r.negative).toBe(true);
    expect(r.text).toBe("(12,380)");
    expect(r.text).not.toContain("-");
  });

  it("keeps piasters on a negative with a real fraction", () => {
    expect(accountingMoney("-12380.50", "en")).toEqual({ text: "(12,380.50)", negative: true });
  });

  it("Arabic parentheses shape is preserved", () => {
    const neg = accountingMoney("-250.5", "ar");
    expect(neg.negative).toBe(true);
    expect(neg.text.startsWith("(")).toBe(true);
    expect(neg.text.endsWith(")")).toBe(true);
  });

  it("re-exports the shared (always-2dp) money formatter unchanged", () => {
    expect(money("1000", "en")).toBe("1,000.00");
  });
});
