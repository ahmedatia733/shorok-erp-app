/**
 * Sales Invoice product dropdown: shows COST per meter only — never the sale
 * price (which is manual). Covers required tests 1–3, 5, 8, 9.
 */
import { salesVariantExtra, toSalesVariantItem, type SalesVariant } from "./sales-variant";

const mk = (over: Partial<SalesVariant>): SalesVariant => ({
  id: "v", skuCode: "AP 1023", skuNameAr: "أصفر", sizeMetersPerBoard: "4", defaultCostPrice: "498", ...over,
});

describe("sales product dropdown — cost only, no sale price", () => {
  it("1/2) the dropdown line never contains the sale-price label or value", () => {
    const line = salesVariantExtra("498");
    expect(line).not.toContain("سعر بيع المتر");
    expect(line).not.toContain("بيع");
  });

  it("3) the dropdown line shows «سعر التكلفة للمتر <cost>»", () => {
    expect(salesVariantExtra("498")).toBe("سعر التكلفة للمتر 498");
    expect(salesVariantExtra("750")).toBe("سعر التكلفة للمتر 750");
  });

  it("5) the dropdown option carries the cost but NOT a sale price", () => {
    const item = toSalesVariantItem(mk({ defaultCostPrice: "498" }));
    expect(item.cost).toBe("498");
    expect(item.price).toBeUndefined();
  });

  it("8/9) cost loads from defaultPurchasePricePerMeter (498, 625, 635, 750)", () => {
    for (const c of ["498", "625", "635", "750"]) {
      expect(toSalesVariantItem(mk({ defaultCostPrice: c })).cost).toBe(c);
      expect(salesVariantExtra(c)).toBe(`سعر التكلفة للمتر ${c}`);
    }
  });

  it("handles a missing cost gracefully", () => {
    expect(salesVariantExtra("")).toBe("سعر التكلفة للمتر —");
    expect(salesVariantExtra(null)).toBe("سعر التكلفة للمتر —");
  });
});
