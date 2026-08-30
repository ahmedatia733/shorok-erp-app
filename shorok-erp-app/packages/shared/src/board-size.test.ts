import {
  boardSizeUnits,
  classifyBoardSize,
  formatBoardMeters,
  parseMovementSearch,
  unitsToDecimalString,
} from "./board-size";

describe("classifyBoardSize", () => {
  it("recognises the two standard sizes", () => {
    expect(classifyBoardSize("5.25").kind).toBe("BIG");
    expect(classifyBoardSize("5.25").shortAr).toBe("ك");
    expect(classifyBoardSize("5.25").longAr).toBe("كبير");
    expect(classifyBoardSize("4").kind).toBe("SMALL");
    expect(classifyBoardSize("4").shortAr).toBe("ص");
    expect(classifyBoardSize("4").longAr).toBe("صغير");
  });

  it("recognises them however the database padded them", () => {
    // Decimal(10,4) hands back "5.2500" and "4.0000", not "5.25" and "4".
    for (const big of ["5.25", "5.250", "5.2500", 5.25]) expect(classifyBoardSize(big).kind).toBe("BIG");
    for (const small of ["4", "4.0", "4.00", "4.0000", 4]) expect(classifyBoardSize(small).kind).toBe("SMALL");
  });

  it("treats every other size as a custom one", () => {
    for (const custom of ["3.75", "6.60", "4.80", "3.4375", "10"]) {
      const c = classifyBoardSize(custom);
      expect(c.kind).toBe("CUSTOM");
      expect(c.shortAr).toBe("م ق");
      expect(c.longAr).toBe("مقاس مخصص");
    }
  });

  it("keeps the actual measurement visible on a custom size", () => {
    // The whole point: «م ق» alone would not say which board moved.
    expect(classifyBoardSize("3.7500").meters).toBe("3.75");
    expect(classifyBoardSize("4.8000").meters).toBe("4.80");
    expect(classifyBoardSize("6.6000").meters).toBe("6.60");
  });

  it("never rounds a size down to fewer digits than it has", () => {
    // 3.4375 is a real catalogue size; showing "3.44" would be a different board.
    expect(classifyBoardSize("3.4375").meters).toBe("3.4375");
  });

  it("shows two decimals even when the size is whole", () => {
    expect(formatBoardMeters("4.0000")).toBe("4.00");
    expect(formatBoardMeters("5.2500")).toBe("5.25");
  });
});

describe("boardSizeUnits — exact, not floating point", () => {
  it("scales to ten-thousandths without floating-point drift", () => {
    expect(boardSizeUnits("5.25")).toBe(52500);
    expect(boardSizeUnits("4")).toBe(40000);
    expect(boardSizeUnits("4.80")).toBe(48000);
    expect(boardSizeUnits("3.4375")).toBe(34375);
  });

  it("makes the padded and unpadded forms compare equal", () => {
    expect(boardSizeUnits("4")).toBe(boardSizeUnits("4.0000"));
    expect(boardSizeUnits("5.25")).toBe(boardSizeUnits("5.2500"));
  });

  it("rejects text that is not a number", () => {
    for (const junk of ["", "abc", "5.2.5", "١٢٣x", null, undefined]) {
      expect(boardSizeUnits(junk as string)).toBeNull();
    }
  });

  it("rejects precision the column cannot hold, rather than rounding it in", () => {
    // 3.14159 could never equal a stored Decimal(10,4); pretending otherwise
    // would match a board the user did not ask for.
    expect(boardSizeUnits("3.14159")).toBeNull();
  });

  it("round-trips through the query-building form", () => {
    expect(unitsToDecimalString(52500)).toBe("5.2500");
    expect(unitsToDecimalString(34375)).toBe("3.4375");
  });
});

describe("parseMovementSearch", () => {
  it("reads the one-letter Arabic aliases", () => {
    expect(parseMovementSearch("ك").sizeKind).toBe("BIG");
    expect(parseMovementSearch("ص").sizeKind).toBe("SMALL");
  });

  it("reads the full Arabic words", () => {
    expect(parseMovementSearch("كبير").sizeKind).toBe("BIG");
    expect(parseMovementSearch("صغير").sizeKind).toBe("SMALL");
    expect(parseMovementSearch("مخصص").sizeKind).toBe("CUSTOM");
    expect(parseMovementSearch("مقاس مخصص").sizeKind).toBe("CUSTOM");
  });

  it("reads «م ق», which is two words", () => {
    expect(parseMovementSearch("م ق").sizeKind).toBe("CUSTOM");
    expect(parseMovementSearch("مق").sizeKind).toBe("CUSTOM");
    expect(parseMovementSearch("م ق").terms).toEqual([]);
  });

  it("reads the standard sizes typed as numbers", () => {
    expect(parseMovementSearch("5.25").sizeKind).toBe("BIG");
    expect(parseMovementSearch("4").sizeKind).toBe("SMALL");
    expect(parseMovementSearch("4.00").sizeKind).toBe("SMALL");
  });

  it("treats another measurement as an exact size", () => {
    expect(parseMovementSearch("3.75").exactSizeUnits).toBe(37500);
    expect(parseMovementSearch("3.75").sizeKind).toBeNull();
    expect(parseMovementSearch("6.6").exactSizeUnits).toBe(66000);
  });

  it("combines a product code with a size class", () => {
    for (const [q, kind] of [["1010 ك", "BIG"], ["1010 ص", "SMALL"], ["1010 م ق", "CUSTOM"]] as const) {
      const r = parseMovementSearch(q);
      expect(r.terms).toEqual(["1010"]);
      expect(r.sizeKind).toBe(kind);
    }
  });

  it("combines a product code with an exact size", () => {
    const r = parseMovementSearch("1010 3.75");
    expect(r.terms).toEqual(["1010"]);
    expect(r.exactSizeUnits).toBe(37500);
  });

  it("keeps a whole-number product code as text, not a size", () => {
    // 1010 is a code. Only 5.25 and 4 are sizes without a decimal point.
    for (const code of ["1010", "9005", "250", "115"]) {
      const r = parseMovementSearch(code);
      expect(r.terms).toEqual([code]);
      expect(r.sizeKind).toBeNull();
      expect(r.exactSizeUnits).toBeNull();
    }
  });

  /**
   * The trap this parser exists to avoid. ك and ص are ordinary Arabic letters,
   * so a substring search for them would turn most product names into a size
   * filter and silently hide the rows the user was reading.
   */
  it("does NOT treat a name merely containing ك or ص as a size search", () => {
    for (const name of ["كوبرا", "أكسسوار", "خشبي", "قصدير", "بصمة", "مخصصات"]) {
      const r = parseMovementSearch(name);
      expect(r.sizeKind).toBeNull();
      expect(r.terms).toEqual([name]);
    }
  });

  it("keeps a multi-word product name as words to match, not as a size", () => {
    // «سيلفر مط» is a real product name. It must stay two ordinary terms.
    const r = parseMovementSearch("سيلفر مط");
    expect(r.sizeKind).toBeNull();
    expect(r.terms).toEqual(["سيلفر", "مط"]);
  });

  it("does not let a name containing ك hijack a code search", () => {
    const r = parseMovementSearch("1010 كوبرا");
    expect(r.sizeKind).toBeNull();
    expect(r.terms).toEqual(["1010", "كوبرا"]);
  });

  it("normalises spacing and Arabic-Indic digits", () => {
    expect(parseMovementSearch("  1010    ك  ").terms).toEqual(["1010"]);
    expect(parseMovementSearch("  1010    ك  ").sizeKind).toBe("BIG");
    expect(parseMovementSearch("٤").sizeKind).toBe("SMALL");
    expect(parseMovementSearch("٥٫٢٥").sizeKind).toBe("BIG");
  });

  it("returns nothing for an empty query", () => {
    for (const empty of ["", "   ", null, undefined]) {
      const r = parseMovementSearch(empty);
      expect(r.terms).toEqual([]);
      expect(r.sizeKind).toBeNull();
      expect(r.exactSizeUnits).toBeNull();
    }
  });

  it("lets the last size token win rather than silently ANDing two classes", () => {
    // Asking for ك and ص at once has no answer; taking the latest keeps the
    // box predictable while the user edits it.
    expect(parseMovementSearch("ك ص").sizeKind).toBe("SMALL");
  });
});
