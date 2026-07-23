import { resolveRange, groupKeyExpr, businessDay } from "./report-range";

describe("report-range", () => {
  const now = new Date("2026-05-14T09:00:00Z"); // a Thursday

  it("today / yesterday are inclusive single days", () => {
    expect(resolveRange("today", undefined, now)).toEqual({ from: "2026-05-14", to: "2026-05-14" });
    expect(resolveRange("yesterday", undefined, now)).toEqual({ from: "2026-05-13", to: "2026-05-13" });
  });

  it("this_month / last_month span full months", () => {
    expect(resolveRange("this_month", undefined, now)).toEqual({ from: "2026-05-01", to: "2026-05-31" });
    expect(resolveRange("last_month", undefined, now)).toEqual({ from: "2026-04-01", to: "2026-04-30" });
  });

  it("quarters and years are fixed", () => {
    expect(resolveRange("q1", undefined, now)).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(resolveRange("q4", undefined, now)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(resolveRange("this_year", undefined, now)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(resolveRange("last_year", undefined, now)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });

  it("custom passes explicit inclusive bounds through", () => {
    expect(resolveRange("custom", { from: "2026-02-01", to: "2026-02-09" }, now)).toEqual({ from: "2026-02-01", to: "2026-02-09" });
  });

  it("last_month wraps the year at January", () => {
    const jan = new Date("2026-01-10T00:00:00Z");
    expect(resolveRange("last_month", undefined, jan)).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("businessDay renders an ISO date", () => {
    expect(businessDay(now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("groupKeyExpr emits the right SQL label", () => {
    expect(groupKeyExpr("month", "d")).toContain("YYYY-MM");
    expect(groupKeyExpr("quarter", "d")).toContain("quarter");
    expect(groupKeyExpr("year", "d")).toContain("YYYY");
  });
});
