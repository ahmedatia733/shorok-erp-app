import { filterOptions, type SearchableOption } from "./searchable-filter";

const opts: SearchableOption[] = [
  { value: "c1", label: "شركة الأمل — CUST-001 — 01000000001", keywords: "CUST-001 01000000001" },
  { value: "c2", label: "Bright Co — CUST-002 — 01555000002", keywords: "CUST-002 01555000002 Bright" },
  { value: "a1", label: "1100 — النقدية بالصندوق", keywords: "1100 النقدية بالصندوق Cash on Hand" },
  { value: "a2", label: "1210 — العملاء", keywords: "1210 العملاء Accounts Receivable" },
];

describe("filterOptions (searchable combobox)", () => {
  it("returns ALL options for an empty query (list shows immediately)", () => {
    expect(filterOptions(opts, "").length).toBe(4);
    expect(filterOptions(opts, "   ").length).toBe(4);
  });
  it("filters by Arabic label text", () => {
    expect(filterOptions(opts, "النقدية").map((o) => o.value)).toEqual(["a1"]);
    expect(filterOptions(opts, "الأمل").map((o) => o.value)).toEqual(["c1"]);
  });
  it("filters by English keyword (name)", () => {
    expect(filterOptions(opts, "receivable").map((o) => o.value)).toEqual(["a2"]);
    expect(filterOptions(opts, "bright").map((o) => o.value)).toEqual(["c2"]);
  });
  it("filters by account code and customer code", () => {
    expect(filterOptions(opts, "1100").map((o) => o.value)).toEqual(["a1"]);
    expect(filterOptions(opts, "cust-002").map((o) => o.value)).toEqual(["c2"]);
  });
  it("filters by phone number when present", () => {
    expect(filterOptions(opts, "01000000001").map((o) => o.value)).toEqual(["c1"]);
  });
  it("is case-insensitive and trims", () => {
    expect(filterOptions(opts, "  CASH ").map((o) => o.value)).toEqual(["a1"]);
  });
  it("returns an empty array when nothing matches (empty-state path)", () => {
    expect(filterOptions(opts, "zzz-nomatch")).toEqual([]);
  });
});
