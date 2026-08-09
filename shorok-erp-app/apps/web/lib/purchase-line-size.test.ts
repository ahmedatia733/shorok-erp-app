/**
 * The size a purchase line is buying.
 *
 * This is what decides which exact ProductVariant the purchase lands on, so the
 * rule that matters most is the negative one: when the user has not said what
 * size they bought, nothing is guessed on their behalf.
 */
import { purchaseLineSize, SIZE_LARGE, SIZE_SMALL } from "./purchase-line-size";

const line = (over: Partial<Parameters<typeof purchaseLineSize>[0]> = {}) => ({
  sizeChoice: "" as "" | "K" | "S",
  customL: "",
  customW: "",
  ...over,
});

describe("purchaseLineSize", () => {
  it("reads ك as the standard large board and ص as the small one", () => {
    expect(purchaseLineSize(line({ sizeChoice: "K" }))).toBe(SIZE_LARGE);
    expect(purchaseLineSize(line({ sizeChoice: "S" }))).toBe(SIZE_SMALL);
    expect(SIZE_LARGE).toBe("5.25");
    expect(SIZE_SMALL).toBe("4");
  });

  it("returns nothing at all when no size has been chosen", () => {
    // A variant must never be invented from an empty line.
    expect(purchaseLineSize(line())).toBeNull();
    expect(purchaseLineSize(line({ customL: "   " }))).toBeNull();
    expect(purchaseLineSize(line({ customL: "0" }))).toBeNull();
    expect(purchaseLineSize(line({ customW: "3" }))).toBeNull();
  });

  it("treats a length alone as a one-dimensional board, like ك and ص", () => {
    expect(purchaseLineSize(line({ customL: "3.75" }))).toBe("3.7500");
  });

  it("multiplies a genuine two-dimensional board exactly", () => {
    expect(purchaseLineSize(line({ customL: "3.20", customW: "1.25" }))).toBe("4.0000");
  });

  it("refuses a zero or negative width rather than silently dropping it", () => {
    expect(purchaseLineSize(line({ customL: "3", customW: "0" }))).toBeNull();
    expect(purchaseLineSize(line({ customL: "3", customW: "-1" }))).toBeNull();
  });

  it("lets the explicit ك / ص choice win over leftover custom values", () => {
    expect(purchaseLineSize(line({ sizeChoice: "K", customL: "9", customW: "9" }))).toBe(SIZE_LARGE);
  });
});
