/**
 * The size badge, pinned.
 *
 * «ك» and «ص» are what a storekeeper reads off the card before moving stock, so
 * the rule that produces them is worth stating as assertions rather than
 * trusting to a glance: exact-Decimal equality, no invented second dimension,
 * and an unusable size that blocks the option instead of guessing.
 */
import { Decimal } from "decimal.js";
import {
  classifyBoardSize,
  classifyTransferSizeOption,
  LARGE_BOARD_METRES,
  SizeClassificationError,
  SMALL_BOARD_METRES,
  tryClassifyTransferSizeOption,
} from "../../src/modules/inventory-transfers/size-classification";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof SizeClassificationError ? e.code : `unexpected:${(e as Error).name}`;
  }
  return "no_error";
};

describe("standard 5.25 m board is ك", () => {
  it.each(["5.25", "5.2500", "5.25000", 5.25])("classifies %p as LARGE", (v) => {
    expect(classifyBoardSize(v as string | number)).toBe("LARGE");
  });

  it("accepts a Prisma-style Decimal instance", () => {
    expect(classifyBoardSize(new Decimal("5.2500"))).toBe("LARGE");
  });

  it("renders the Arabic card label", () => {
    const d = classifyTransferSizeOption({ sizeMetersPerBoard: "5.2500" });
    expect(d.badgeAr).toBe("ك");
    expect(d.dimensionsLabelAr).toBe("5.25 م");
    expect(d.labelAr).toBe("ك — 5.25 م");
  });
});

describe("standard 4.00 m board is ص", () => {
  it.each(["4", "4.0", "4.0000", 4])("classifies %p as SMALL", (v) => {
    expect(classifyBoardSize(v as string | number)).toBe("SMALL");
  });

  it("renders the Arabic card label", () => {
    const d = classifyTransferSizeOption({ sizeMetersPerBoard: "4.0000" });
    expect(d.badgeAr).toBe("ص");
    expect(d.dimensionsLabelAr).toBe("4.00 م");
    expect(d.labelAr).toBe("ص — 4.00 م");
  });
});

describe("anything else is م/خ", () => {
  it.each(["6", "6.0000", "3.5", "3.75", "4.8", "3.4375", "5.2499", "4.0001"])(
    "classifies %p as CUSTOM",
    (v) => {
      expect(classifyBoardSize(v)).toBe("CUSTOM");
    },
  );

  it("renders a length-only custom label without inventing a width", () => {
    const d = classifyTransferSizeOption({ sizeMetersPerBoard: "6" });
    expect(d.badgeAr).toBe("م/خ");
    expect(d.labelAr).toBe("م/خ — 6.00 م");
    expect(d.widthMeters).toBeNull();
    expect(d.dimensionsLabelAr).not.toContain("×");
  });

  it("renders length × width ONLY when a width is genuinely supplied", () => {
    // A ProductVariant never carries a width, so this shape can only come from
    // a caller that genuinely has one. Exercised here with a synthetic object
    // rather than by altering any production-derived record.
    const d = classifyTransferSizeOption({ sizeMetersPerBoard: "3", widthMeters: "3" });
    expect(d.badgeAr).toBe("م/خ");
    expect(d.dimensionsLabelAr).toBe("3.00 × 3.00 م");
    expect(d.labelAr).toBe("م/خ — 3.00 × 3.00 م");
    expect(d.widthMeters).toBe("3.0000");
  });

  it.each([null, undefined, "", 0, "0", -1, "-2"])(
    "treats the unusable width %p as absent instead of printing it",
    (w) => {
      const d = classifyTransferSizeOption({ sizeMetersPerBoard: "6", widthMeters: w as never });
      expect(d.widthMeters).toBeNull();
      expect(d.dimensionsLabelAr).toBe("6.00 م");
    },
  );
});

describe("exact Decimal comparison, never floating point", () => {
  it("uses Decimal equality rather than Number equality", () => {
    // The real hazard is precision loss on conversion, not arithmetic drift:
    // 5.25 and 4 are dyadic rationals and survive float arithmetic exactly, but
    // a stored value carrying more precision than a double can hold collapses
    // onto them. `Number("5.250000000000000000001") === 5.25` is TRUE, so a
    // Number-based check would label a non-standard board as a standard ك.
    const nearlyLarge = "5.250000000000000000001";
    const nearlySmall = "4.0000000000000001";
    expect(Number(nearlyLarge) === 5.25).toBe(true); // the trap
    expect(Number(nearlySmall) === 4).toBe(true); // the trap
    // Decimal is not fooled, so neither is the badge.
    expect(classifyBoardSize(nearlyLarge)).toBe("CUSTOM");
    expect(classifyBoardSize(nearlySmall)).toBe("CUSTOM");
  });

  it("the canonical constants are Decimals, not numbers", () => {
    expect(LARGE_BOARD_METRES).toBeInstanceOf(Decimal);
    expect(SMALL_BOARD_METRES).toBeInstanceOf(Decimal);
    expect(LARGE_BOARD_METRES.equals("5.2500")).toBe(true);
    expect(SMALL_BOARD_METRES.equals("4.0000")).toBe(true);
  });

  it("a size just off standard is never rounded into a standard badge", () => {
    expect(classifyBoardSize("5.2501")).toBe("CUSTOM");
    expect(classifyBoardSize("3.9999")).toBe("CUSTOM");
  });
});

describe("an unusable size blocks the option", () => {
  it("rejects a missing size", () => {
    expect(code(() => classifyBoardSize(null))).toBe("size_missing");
    expect(code(() => classifyBoardSize(undefined))).toBe("size_missing");
  });

  it("rejects zero and negative sizes", () => {
    expect(code(() => classifyBoardSize("0"))).toBe("size_not_positive");
    expect(code(() => classifyBoardSize("-5.25"))).toBe("size_not_positive");
  });

  it("reports unparseable input as a typed error, never a raw DecimalError", () => {
    expect(code(() => classifyBoardSize("abc"))).toBe("size_invalid");
    expect(code(() => classifyBoardSize("NaN"))).toBe("size_invalid");
  });

  it("the non-throwing variant yields null so a bad row can be skipped or disabled", () => {
    expect(tryClassifyTransferSizeOption({ sizeMetersPerBoard: null })).toBeNull();
    expect(tryClassifyTransferSizeOption({ sizeMetersPerBoard: "0" })).toBeNull();
    expect(tryClassifyTransferSizeOption({ sizeMetersPerBoard: "abc" })).toBeNull();
    expect(tryClassifyTransferSizeOption({ sizeMetersPerBoard: "5.25" })?.badgeAr).toBe("ك");
  });
});

describe("classification is pure", () => {
  it("performs no persistence and needs no database", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../src/modules/inventory-transfers/size-classification.ts"),
      "utf8",
    ) as string;
    for (const forbidden of ["prisma", "PrismaService", "$queryRaw", "$executeRaw", "await "]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it("does not mutate its input", () => {
    const input = { sizeMetersPerBoard: "5.2500", widthMeters: null as string | null };
    const snapshot = JSON.stringify(input);
    classifyTransferSizeOption(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
