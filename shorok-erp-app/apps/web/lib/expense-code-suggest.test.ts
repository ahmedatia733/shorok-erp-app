/**
 * The suggested account code.
 *
 * It only ever proposes; the field stays editable and the server owns
 * uniqueness across the whole chart of accounts. What it must not do is propose
 * a code that is already taken, or walk off the end of the expense range.
 */
import { suggestExpenseCode } from "./expense-code";

describe("suggestExpenseCode", () => {
  it("starts the expense range when nothing is there yet", () => {
    expect(suggestExpenseCode([])).toBe("6100");
    expect(suggestExpenseCode(["CASH", "1200", "4100"])).toBe("6100");
  });

  it("follows the hundreds pattern the chart already uses", () => {
    expect(suggestExpenseCode(["6100", "6200", "6300"])).toBe("6400");
    // Production's real shape: 6000 is the parent heading, 6100–6700 the items.
    expect(suggestExpenseCode(["6000", "6100", "6200", "6300", "6400", "6500", "6600", "6700"])).toBe(
      "6800",
    );
  });

  it("never proposes a code that is already taken", () => {
    const existing = ["6100", "6200", "6300", "6400", "6500", "6600", "6700"];
    expect(existing).not.toContain(suggestExpenseCode(existing));
  });

  it("ignores codes outside the expense range when picking the next one", () => {
    expect(suggestExpenseCode(["6100", "7100", "9999", "CASH-3"])).toBe("6200");
  });

  it("steps by one once the hundreds are exhausted, instead of leaving the range", () => {
    const full = Array.from({ length: 10 }, (_, i) => String(6000 + i * 100));
    // 6900 is the last hundred; the next suggestion must stay a usable code
    // rather than becoming 7000, which belongs to a different section.
    expect(suggestExpenseCode(full)).toBe("6901");
  });

  it("keeps counting from a non-round code", () => {
    expect(suggestExpenseCode(["6100", "6101"])).toBe("6102");
  });
});
