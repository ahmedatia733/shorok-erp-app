/**
 * Test 11: switching variants must not retain the previous variant's price or
 * size. Proves the reset loads the NEW variant's default price and clears any
 * per-line size overrides so the new variant's own size drives the meters.
 */
import { switchVariantLine } from "./variant-line";

describe("switchVariantLine", () => {
  it("loads the new variant's default price and clears old size overrides", () => {
    // Simulate a line previously customised for variant A (490, custom 1.5×3.5).
    const reset = switchVariantLine("variant-B", "498.00");
    expect(reset).toEqual({
      productVariantId: "variant-B",
      unitPrice: "498.00",
      sizeChoice: "",
      customL: "",
      customW: "",
    });
  });

  it("sales loads the sale price, purchase loads the purchase price (caller-supplied)", () => {
    expect(switchVariantLine("v", "498.00").unitPrice).toBe("498.00"); // sale
    expect(switchVariantLine("v", "625.00").unitPrice).toBe("625.00"); // purchase/other
  });

  it("never carries a stale price when the new variant has none", () => {
    expect(switchVariantLine("v", undefined).unitPrice).toBe("");
    expect(switchVariantLine("v", null).unitPrice).toBe("");
  });

  it("6) SALES passes an empty price: switching clears the manual sale price + old size", () => {
    // Sales sale price is MANUAL — onVariantChange calls switchVariantLine(id, "").
    const reset = switchVariantLine("variant-B", "");
    expect(reset.unitPrice).toBe("");   // never auto-filled from a default/previous value
    expect(reset.sizeChoice).toBe("");
    expect(reset.customL).toBe("");
    expect(reset.customW).toBe("");
  });
});
