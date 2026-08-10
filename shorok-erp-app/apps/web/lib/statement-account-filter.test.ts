import { describe, expect, it } from "@jest/globals";
import { filterStatementAccounts } from "./statement-account-filter";

/**
 * The account-statement search. What matters is that it narrows on the things
 * people actually type — part of an Arabic name, part of a code — and that it
 * is a pure display filter, so the balances beside it can never move.
 */
describe("filterStatementAccounts", () => {
  const rows = [
    { code: "C-0014", name: "اسلام قاسم", openingBalance: "100.00" },
    { code: "C-0020", name: "مهندس محمد اسماعيل", openingBalance: "200.00" },
    { code: "1100", name: "الصندوق", openingBalance: "300.00" },
    { code: null, name: "حساب بلا كود", openingBalance: "400.00" },
  ];

  it("returns everything for an empty or whitespace query", () => {
    expect(filterStatementAccounts(rows, "")).toHaveLength(4);
    expect(filterStatementAccounts(rows, "   ")).toHaveLength(4);
  });

  it("finds an account by part of its Arabic name", () => {
    expect(filterStatementAccounts(rows, "اسلام").map((r) => r.code)).toEqual(["C-0014"]);
    // A partial that appears in two names returns both.
    expect(filterStatementAccounts(rows, "محمد")).toHaveLength(1);
  });

  it("finds an account by part of its code, without needing the whole thing", () => {
    expect(filterStatementAccounts(rows, "C-00")).toHaveLength(2);
    expect(filterStatementAccounts(rows, "0014").map((r) => r.name)).toEqual(["اسلام قاسم"]);
    expect(filterStatementAccounts(rows, "1100").map((r) => r.name)).toEqual(["الصندوق"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(filterStatementAccounts(rows, "  c-0014  ")).toHaveLength(1);
    expect(filterStatementAccounts(rows, "C-0014")).toHaveLength(1);
  });

  it("returns nothing when nothing matches, rather than falling back to everything", () => {
    expect(filterStatementAccounts(rows, "zzzz")).toHaveLength(0);
  });

  it("copes with an account that has no code", () => {
    expect(filterStatementAccounts(rows, "بلا كود")).toHaveLength(1);
  });

  it("never alters the rows it returns — the balances are untouched", () => {
    const [match] = filterStatementAccounts(rows, "اسلام");
    expect(match).toBe(rows[0]);
    expect(match!.openingBalance).toBe("100.00");
  });
});
