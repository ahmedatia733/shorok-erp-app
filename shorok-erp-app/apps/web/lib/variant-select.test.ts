import { variantLabel, variantSearchText, filterVariants, type VariantItem } from "./variant-select";

const V = (p: Partial<VariantItem> & { id: string }): VariantItem => ({
  skuCode: "1023", colorNameAr: "أصفر", colorNameEn: "yellow", sizeMetersPerBoard: "5.2500", category: "NORMAL", ...p,
});

const items: VariantItem[] = [
  V({ id: "a", skuCode: "1023", colorNameAr: "أصفر", colorNameEn: "yellow", sizeMetersPerBoard: "5.2500" }),
  V({ id: "b", skuCode: "1023", colorNameAr: "أصفر", colorNameEn: "yellow", sizeMetersPerBoard: "4.0000" }),
  V({ id: "c", skuCode: "113", colorNameAr: "اوف وايت", colorNameEn: "off white", sizeMetersPerBoard: "4.0000" }),
];

describe("variant-select helpers", () => {
  it("builds the combined label with trimmed size", () => {
    expect(variantLabel(items[0])).toBe("1023 — أصفر — مقاس 5.25 م");
    expect(variantLabel(items[1])).toBe("1023 — أصفر — مقاس 4 م");
  });

  it("13) searches by SKU code", () => {
    expect(filterVariants(items, "113").map((v) => v.id)).toEqual(["c"]);
  });

  it("14) searches by Arabic name", () => {
    expect(filterVariants(items, "اوف").map((v) => v.id)).toEqual(["c"]);
  });

  it("searches by English name and by color", () => {
    expect(filterVariants(items, "yellow").map((v) => v.id).sort()).toEqual(["a", "b"]);
    expect(filterVariants(items, "أصفر").map((v) => v.id).sort()).toEqual(["a", "b"]);
  });

  it("16) size is part of the search so one size is distinguishable from another", () => {
    expect(filterVariants(items, "1023 5.25").map((v) => v.id)).toEqual(["a"]);
    expect(filterVariants(items, "1023 4").map((v) => v.id)).toEqual(["b"]);
  });

  it("every term must match (AND search)", () => {
    expect(filterVariants(items, "1023 اوف")).toHaveLength(0);
  });

  it("empty query returns all", () => {
    expect(filterVariants(items, "  ")).toHaveLength(3);
  });

  it("search text exposes code/color/size/category", () => {
    const t = variantSearchText(items[0]);
    expect(t).toContain("1023");
    expect(t).toContain("أصفر");
    expect(t).toContain("yellow");
    expect(t).toContain("5.25");
    expect(t).toContain("normal");
  });
});

describe("variantLabel — a base product has no size to show", () => {
  const base = { id: "x", skuCode: "1337", colorNameAr: "صاج", sizeMetersPerBoard: "" };

  it("labels a product with no size by its code and name alone", () => {
    // «مقاس 0 م» would put a size on screen that the product does not have.
    expect(variantLabel(base)).toBe("1337 — صاج");
    expect(variantLabel(base)).not.toContain("مقاس");
  });

  it("treats a zero size as no size rather than printing it", () => {
    expect(variantLabel({ ...base, sizeMetersPerBoard: "0" })).toBe("1337 — صاج");
    expect(variantLabel({ ...base, sizeMetersPerBoard: "0.0000" })).toBe("1337 — صاج");
  });

  it("still shows a real size exactly as before", () => {
    expect(variantLabel({ ...base, sizeMetersPerBoard: "5.2500" })).toBe("1337 — صاج — مقاس 5.25 م");
  });
});
