/**
 * Sales Invoice customer selector — search behavior (tests 1–3).
 */
import { filterCustomerOptions, toCustomerOptions } from "./customer-options";
import type { CustomerRow } from "./customers-client";

const customers: CustomerRow[] = [
  { id: "1", code: "C-0001", nameAr: "صلاح مكي", phone: "01000000001", active: true, createdAt: "" },
  { id: "2", code: "C-0002", nameAr: "مارتن فايز", phone: null, active: true, createdAt: "" },
  { id: "3", code: "C-0019", nameAr: "شركة النور", phone: "01234567890", active: true, createdAt: "" },
];
const opts = toCustomerOptions(customers);

describe("customer selector search", () => {
  it("1) searches by Arabic name (case/space-insensitive)", () => {
    expect(filterCustomerOptions(opts, "  صلاح ").map((o) => o.value)).toEqual(["1"]);
    expect(filterCustomerOptions(opts, "النور").map((o) => o.value)).toEqual(["3"]);
  });

  it("2) searches by customer code", () => {
    expect(filterCustomerOptions(opts, "c-0019").map((o) => o.value)).toEqual(["3"]);
    expect(filterCustomerOptions(opts, "C-0002").map((o) => o.value)).toEqual(["2"]);
  });

  it("searches by phone when available", () => {
    expect(filterCustomerOptions(opts, "0123456").map((o) => o.value)).toEqual(["3"]);
  });

  it("3) empty query returns the full list (open + pick without typing)", () => {
    expect(filterCustomerOptions(opts, "").map((o) => o.value)).toEqual(["1", "2", "3"]);
    expect(filterCustomerOptions(opts, "   ")).toHaveLength(3);
  });

  it("shows code — name (— phone) in the label", () => {
    expect(opts[0]!.label).toBe("C-0001 — صلاح مكي — 01000000001");
    expect(opts[1]!.label).toBe("C-0002 — مارتن فايز"); // no phone → no trailing dash
  });
});
