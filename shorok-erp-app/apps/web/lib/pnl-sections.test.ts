import { describe, expect, it } from "@jest/globals";
import { classifyExpense, groupExpenses, splitRevenue, sumAmounts, type PnlAmountLine } from "./pnl-sections";

const line = (code: string, nameAr: string, amount: string): PnlAmountLine =>
  ({ accountId: `id-${code}`, code, nameAr, nameEn: code, amount });

/**
 * These helpers only ARRANGE what the API already computed. The tests exist to
 * prove the arrangement cannot change a total — above all that a sales return,
 * which is already inside the API's revenue figure, is never deducted twice.
 */
describe("splitRevenue", () => {
  const sales = line("4100", "إيرادات المبيعات", "4040372.50");
  const returns = line("4200", "مردودات المبيعات", "-76007.50");

  it("reconstructs gross revenue and shows returns as a positive deduction", () => {
    const s = splitRevenue([sales, returns]);
    expect(s.grossTotal).toBe("4040372.50");
    expect(s.deductionsTotal).toBe("76007.50");
    expect(s.deductions[0]!.amount).toBe("76007.50"); // magnitude, not the raw negative
  });

  it("net revenue equals the API's own revenue total — the return applied ONCE", () => {
    const s = splitRevenue([sales, returns]);
    // The canonical API `revenue` is the plain sum of the same lines.
    const canonical = sumAmounts([sales, returns]);
    expect(canonical).toBe("3964365.00");
    expect(s.netRevenue).toBe(canonical);
    // The failure this guards against: 4040372.50 − 76007.50 − 76007.50.
    expect(s.netRevenue).not.toBe("3888357.50");
  });

  it("holds the identity gross − deductions = net for any mix", () => {
    for (const lines of [
      [line("4100", "مبيعات", "1000000.00"), line("4200", "مردودات", "-50000.00")],
      [line("4100", "مبيعات", "1000000.00")],
      [line("4200", "مردودات", "-50000.00")],
      [],
    ]) {
      const s = splitRevenue(lines);
      expect(Number(s.grossTotal) - Number(s.deductionsTotal)).toBeCloseTo(Number(s.netRevenue), 2);
      expect(s.netRevenue).toBe(sumAmounts(lines));
    }
  });

  it("with no returns, net revenue is simply the revenue", () => {
    const s = splitRevenue([sales]);
    expect(s.deductions).toHaveLength(0);
    expect(s.deductionsTotal).toBe("0.00");
    expect(s.netRevenue).toBe("4040372.50");
  });

  it("never drops a revenue account", () => {
    const lines = [sales, returns, line("4300", "إيرادات أخرى", "125.00")];
    const s = splitRevenue(lines);
    expect(s.gross.length + s.deductions.length).toBe(lines.length);
  });
});

describe("classifyExpense", () => {
  it("maps the accounts that exist today to their reading sections", () => {
    expect(classifyExpense(line("6100", "النقل والشحن", "0"))).toBe("SELLING");
    for (const [code, name] of [["6200", "الرواتب والأجور"], ["6300", "الكهرباء والمرافق"], ["6400", "الإيجارات"], ["6700", "الصيانة"]]) {
      expect(classifyExpense(line(code!, name!, "0"))).toBe("ADMIN");
    }
    expect(classifyExpense(line("6500", "المصروفات البنكية", "0"))).toBe("FINANCE");
    expect(classifyExpense(line("6600", "مصروفات متنوعة", "0"))).toBe("OTHER");
  });

  it("recognises a depreciation account by name, whatever its code", () => {
    expect(classifyExpense(line("6800", "إهلاك الأصول الثابتة", "0"))).toBe("DEPRECIATION");
    expect(classifyExpense({ code: "9999", nameAr: "x", nameEn: "Depreciation expense" })).toBe("DEPRECIATION");
  });

  it("sends an account nobody has invented yet to «مصروفات أخرى», never nowhere", () => {
    for (const code of ["6900", "7100", "", "ZZ"]) {
      expect(classifyExpense(line(code, "مصروف جديد", "0"))).toBe("OTHER");
    }
  });
});

describe("groupExpenses", () => {
  const lines = [
    line("6100", "النقل والشحن", "900.00"),
    line("6200", "الرواتب والأجور", "10000.00"),
    line("6400", "الإيجارات", "5000.00"),
    line("6500", "المصروفات البنكية", "250.00"),
    line("6600", "مصروفات متنوعة", "75.00"),
    line("6900", "مصروف مستقبلي", "25.00"),
  ];

  it("groups in reading order and totals each section", () => {
    const g = groupExpenses(lines);
    expect(g.map((x) => x.id)).toEqual(["SELLING", "ADMIN", "FINANCE", "OTHER"]);
    expect(g.find((x) => x.id === "SELLING")!.total).toBe("900.00");
    expect(g.find((x) => x.id === "ADMIN")!.total).toBe("15000.00");
    expect(g.find((x) => x.id === "FINANCE")!.total).toBe("250.00");
    expect(g.find((x) => x.id === "OTHER")!.total).toBe("100.00"); // 75 + the unknown 25
  });

  it("the section totals add up to the canonical expense total", () => {
    const groups = groupExpenses(lines);
    const grouped = sumAmounts(groups.map((g) => ({ amount: g.total })));
    expect(grouped).toBe(sumAmounts(lines));
    expect(grouped).toBe("16250.00");
  });

  it("every account lands in exactly one section", () => {
    const groups = groupExpenses(lines);
    const seen = groups.flatMap((g) => g.lines.map((l) => l.accountId));
    expect(seen).toHaveLength(lines.length);
    expect(new Set(seen).size).toBe(lines.length);
  });

  it("omits sections that have nothing in them — no padded 0.00 rows", () => {
    const g = groupExpenses([line("6100", "النقل والشحن", "900.00")]);
    expect(g.map((x) => x.id)).toEqual(["SELLING"]);
    expect(g.some((x) => x.id === "DEPRECIATION")).toBe(false);
  });

  it("keeps a credit-balance expense in its section with its sign intact", () => {
    // The display layer decides how a negative reads; grouping must not re-sign it.
    const g = groupExpenses([line("6100", "النقل والشحن", "-900.00")]);
    expect(g[0]!.lines[0]!.amount).toBe("-900.00");
    expect(g[0]!.total).toBe("-900.00");
  });

  it("handles an empty statement", () => {
    expect(groupExpenses([])).toEqual([]);
    expect(sumAmounts([])).toBe("0.00");
  });
});
