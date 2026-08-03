/**
 * The three colour codes added in August 2026 must be findable in the product
 * selector by their code and by their Arabic name, and each must resolve to
 * exactly one variant — the same identity purchasing, sales and inventory all
 * use. A near-miss here shows up as an accountant unable to find a product, or
 * worse, picking the wrong one.
 *
 * The cost/price separation is asserted alongside it: the selector line carries
 * the purchase cost, and the sale price is never part of the product data.
 */
import { filterVariants, variantLabel, variantSearchText, type VariantItem } from "./variant-select";
import { toSalesVariantItem, salesVariantExtra, type SalesVariant } from "./sales-variant";

const PURCHASE_COST = "489.00";

/** The real catalogue shape: one active variant per code, size 4, cost 489. */
const NEW: VariantItem[] = [
  { id: "v-555", skuCode: "555", colorNameAr: "بينك", colorNameEn: "Pink", sizeMetersPerBoard: "4.0000", category: "NORMAL", cost: PURCHASE_COST },
  { id: "v-3005", skuCode: "3005", colorNameAr: "نبيتي لامع", colorNameEn: "Glossy Burgundy", sizeMetersPerBoard: "4.0000", category: "NORMAL", cost: PURCHASE_COST },
  { id: "v-1117", skuCode: "1117", colorNameAr: "أسود برونزي", colorNameEn: "Bronze Black", sizeMetersPerBoard: "4.0000", category: "NORMAL", cost: PURCHASE_COST },
];

// Existing products it must not be confused with — "1117" must not drag in
// "111", and a shared colour word must not collapse two products together.
const EXISTING: VariantItem[] = [
  { id: "v-111", skuCode: "111", colorNameAr: "أبيض", colorNameEn: "White", sizeMetersPerBoard: "4.0000", category: "NORMAL" },
  { id: "v-115", skuCode: "115", colorNameAr: "أسود", colorNameEn: "Black", sizeMetersPerBoard: "5.2500", category: "NORMAL" },
  { id: "v-3005b", skuCode: "300", colorNameAr: "بني", colorNameEn: "Brown", sizeMetersPerBoard: "4.0000", category: "NORMAL" },
];

const ALL = [...EXISTING, ...NEW];

describe("new catalogue products 555 / 3005 / 1117", () => {
  it.each([
    ["555", "v-555"],
    ["3005", "v-3005"],
    ["1117", "v-1117"],
  ])("is found by exact code %s and resolves to one variant", (code, id) => {
    const hits = filterVariants(ALL, code);
    expect(hits.map((v) => v.id)).toContain(id);
    expect(hits.filter((v) => v.skuCode === code)).toHaveLength(1);
  });

  it.each([
    ["بينك", "v-555"],
    ["نبيتي لامع", "v-3005"],
    ["أسود برونزي", "v-1117"],
  ])("is found by Arabic name %s", (name, id) => {
    const hits = filterVariants(ALL, name);
    expect(hits.map((v) => v.id)).toContain(id);
  });

  it("code 1117 does not also match the shorter existing code 111", () => {
    expect(filterVariants(ALL, "1117").map((v) => v.skuCode)).toEqual(["1117"]);
  });

  it("«أسود برونزي» does not collapse with the existing «أسود»", () => {
    // Both terms must match, so the two-word name cannot select the plain one.
    expect(filterVariants(ALL, "أسود برونزي").map((v) => v.id)).toEqual(["v-1117"]);
    // …while searching the single word legitimately returns both.
    expect(filterVariants(ALL, "أسود").map((v) => v.id).sort()).toEqual(["v-1117", "v-115"]);
  });

  it("each label shows code, Arabic name and size", () => {
    expect(variantLabel(NEW[0])).toBe("555 — بينك — مقاس 4 م");
    expect(variantLabel(NEW[1])).toBe("3005 — نبيتي لامع — مقاس 4 م");
    expect(variantLabel(NEW[2])).toBe("1117 — أسود برونزي — مقاس 4 م");
  });

  it("search text carries code, both names and size", () => {
    const t = variantSearchText(NEW[2]);
    expect(t).toContain("1117");
    expect(t).toContain("أسود برونزي");
    expect(t).toContain("bronze black");
    expect(t).toContain("4");
  });

  it("the sales dropdown line shows the cost and never a sale price", () => {
    const sales: SalesVariant = {
      id: "v-555", skuCode: "555", skuNameAr: "بينك",
      sizeMetersPerBoard: "4", defaultCostPrice: PURCHASE_COST,
    };
    const item = toSalesVariantItem(sales);
    const extra = salesVariantExtra(item.cost);
    // The cost is visible on the dropdown's secondary line…
    expect(extra).toContain("489");
    expect(extra).toContain("سعر التكلفة");
    // …and the dropdown item carries no sale price at all, so nothing in this
    // path can prefill 489 as what the customer pays.
    expect(item.price).toBeUndefined();
    expect(item.cost).toBe(PURCHASE_COST);
    expect(Object.keys(sales)).not.toContain("defaultSalePricePerMeter");
  });
});
