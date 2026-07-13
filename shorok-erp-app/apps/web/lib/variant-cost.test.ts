import { resolveVariantCost, COST_MISSING_LABEL } from "./variant-cost";

describe("resolveVariantCost (sales invoice cost display)", () => {
  it("1) large variant with stored avg_cost → actual", () => {
    expect(resolveVariantCost("3010.00", "560")).toEqual({ value: "3010.00", source: "actual" });
  });

  it("2) small variant with stored avg_cost → actual", () => {
    expect(resolveVariantCost("1912.00", "560")).toEqual({ value: "1912.00", source: "actual" });
  });

  it("3) two sizes under one SKU resolve independently (no cross-substitution)", () => {
    const large = resolveVariantCost("2870.00", "560");
    const small = resolveVariantCost("0", "560"); // small has no avg yet → estimate
    expect(large).toEqual({ value: "2870.00", source: "actual" });
    expect(small).toEqual({ value: "560", source: "estimate" });
    expect(large.value).not.toBe(small.value);
  });

  it("4) avg_cost present but no meaningful default → actual", () => {
    expect(resolveVariantCost("2240.0000", "0")).toEqual({ value: "2240.0000", source: "actual" });
  });

  it("5) legacy default present but no avg_cost → estimate", () => {
    expect(resolveVariantCost("0", "650")).toEqual({ value: "650", source: "estimate" });
    expect(resolveVariantCost(null, "650")).toEqual({ value: "650", source: "estimate" });
  });

  it("6) both zero → missing (never a fake 0)", () => {
    const r = resolveVariantCost("0", "0");
    expect(r.source).toBe("missing");
    expect(r.value).toBeNull();
  });

  it("7) null/undefined/empty everywhere → missing", () => {
    expect(resolveVariantCost(null, null).source).toBe("missing");
    expect(resolveVariantCost(undefined, undefined).source).toBe("missing");
    expect(resolveVariantCost("", "").source).toBe("missing");
  });

  it("8) AP variant with only avg_cost (no default) still shows actual", () => {
    expect(resolveVariantCost("288.75", "0")).toEqual({ value: "288.75", source: "actual" });
  });

  it("9) avg_cost strictly preferred over default when both are positive", () => {
    // The exact variant's own avg_cost wins — never the parent/default when a real cost exists.
    expect(resolveVariantCost("2653.00", "560")).toEqual({ value: "2653.00", source: "actual" });
  });

  it("negative or non-numeric values are treated as missing/invalid", () => {
    expect(resolveVariantCost("-5", "-1").source).toBe("missing");
    expect(resolveVariantCost("abc", "def").source).toBe("missing");
  });

  it("exposes a stable missing label", () => {
    expect(COST_MISSING_LABEL).toBe("سعر التكلفة غير مسجل");
  });
});
