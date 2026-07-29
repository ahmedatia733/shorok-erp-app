import { accountingMoney, money } from "./statement-format";

describe("accountingMoney", () => {
  it("formats a positive value plainly (English → Latin digits)", () => {
    const r = accountingMoney("1234.5", "en");
    expect(r.negative).toBe(false);
    expect(r.text).toBe("1,234.50");
  });

  it("wraps a negative value in parentheses instead of a minus sign (English)", () => {
    const r = accountingMoney("-1000", "en");
    expect(r.negative).toBe(true);
    expect(r.text).toBe("(1,000.00)");
    expect(r.text).not.toContain("-");
  });

  it("treats zero as non-negative with no parentheses", () => {
    const r = accountingMoney("0", "en");
    expect(r.negative).toBe(false);
    expect(r.text).toBe("0.00");
  });

  it("uses Arabic-Indic digits for the ar locale but keeps the parentheses shape", () => {
    const pos = accountingMoney("2600", "ar");
    expect(pos.negative).toBe(false);
    // ar-EG renders Arabic-Indic digits, so this is not the Latin "2,600.00".
    expect(pos.text).not.toBe("2,600.00");

    const neg = accountingMoney("-250.5", "ar");
    expect(neg.negative).toBe(true);
    expect(neg.text.startsWith("(")).toBe(true);
    expect(neg.text.endsWith(")")).toBe(true);
  });

  it("re-exports the shared money formatter", () => {
    expect(money("1000", "en")).toBe("1,000.00");
  });
});
