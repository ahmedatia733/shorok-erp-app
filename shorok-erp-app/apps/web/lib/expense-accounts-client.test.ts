/**
 * The expenses client's query building.
 *
 * This is what makes «حفظ PDF» honest: the export hits the same endpoint with
 * the same filters the screen is showing, minus the paging, so it can never
 * print one page of a longer report or silently drop a filter.
 */
import { itemsQuery, movementsQuery } from "./expense-accounts-client";

describe("itemsQuery", () => {
  it("carries the period, the search and the status", () => {
    const q = itemsQuery({ from: "2026-08-01", to: "2026-08-31", search: "كهرباء", status: "active" });
    const params = new URLSearchParams(q.slice(1));
    expect(params.get("from")).toBe("2026-08-01");
    expect(params.get("to")).toBe("2026-08-31");
    expect(params.get("search")).toBe("كهرباء");
    expect(params.get("status")).toBe("active");
  });

  it("omits an empty or whitespace-only search rather than filtering on nothing", () => {
    expect(itemsQuery({ from: "2026-08-01", to: "2026-08-31", search: "   " })).toBe(
      "?from=2026-08-01&to=2026-08-31",
    );
    expect(itemsQuery({ from: "2026-08-01", to: "2026-08-31", search: "" })).toBe(
      "?from=2026-08-01&to=2026-08-31",
    );
  });

  it("yields no query string at all when nothing is filtered", () => {
    expect(itemsQuery({})).toBe("");
  });
});

describe("movementsQuery", () => {
  it("carries every filter the movements screen offers", () => {
    const q = movementsQuery({
      from: "2026-08-01",
      to: "2026-08-31",
      accountId: "11111111-1111-4111-8111-111111111111",
      search: "نقل",
      minAmount: "100",
      maxAmount: "5000",
      limit: 50,
      offset: 100,
    });
    const p = new URLSearchParams(q.slice(1));
    expect(p.get("accountId")).toBe("11111111-1111-4111-8111-111111111111");
    expect(p.get("search")).toBe("نقل");
    expect(p.get("minAmount")).toBe("100");
    expect(p.get("maxAmount")).toBe("5000");
    expect(p.get("limit")).toBe("50");
    expect(p.get("offset")).toBe("100");
  });

  it("drops paging when the caller omits it — which is how the PDF asks for everything", () => {
    const q = movementsQuery({
      from: "2026-08-01",
      to: "2026-08-31",
      accountId: "22222222-2222-4222-8222-222222222222",
      limit: undefined,
      offset: undefined,
    });
    const p = new URLSearchParams(q.slice(1));
    expect(p.has("limit")).toBe(false);
    expect(p.has("offset")).toBe(false);
    // …while every real filter survives, so the export matches the screen.
    expect(p.get("accountId")).toBe("22222222-2222-4222-8222-222222222222");
    expect(p.get("from")).toBe("2026-08-01");
  });

  it("keeps offset 0, which is a real page and not a missing value", () => {
    const p = new URLSearchParams(movementsQuery({ limit: 50, offset: 0 }).slice(1));
    expect(p.get("offset")).toBe("0");
  });

  it("encodes Arabic search text so the request survives the wire", () => {
    const q = movementsQuery({ search: "إيجار المخزن" });
    expect(q).toContain("%");
    expect(new URLSearchParams(q.slice(1)).get("search")).toBe("إيجار المخزن");
  });
});
