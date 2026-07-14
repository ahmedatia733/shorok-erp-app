import { computeDropdownPosition } from "./dropdown-position";

const desktop = { width: 1440, height: 900 };
const narrow = { width: 380, height: 720 };

describe("computeDropdownPosition", () => {
  it("opens downward when there is enough space below", () => {
    const p = computeDropdownPosition({ top: 200, left: 300, width: 260, bottom: 230 }, desktop);
    expect(p.placement).toBe("down");
    expect(p.top).toBe(236); // bottom + gap(6)
    expect(p.maxHeight).toBeGreaterThanOrEqual(280);
  });

  it("opens upward when space below is insufficient and above is roomier", () => {
    // trigger near the bottom of the viewport
    const p = computeDropdownPosition({ top: 820, left: 300, width: 260, bottom: 850 }, desktop);
    expect(p.placement).toBe("up");
    expect(p.bottom).toBe(desktop.height - 820 + 6);
    expect(p.top).toBeUndefined();
    expect(p.maxHeight).toBeLessThanOrEqual(Math.min(desktop.height * 0.6, 520));
  });

  it("width is at least 420 on desktop even for a narrow trigger", () => {
    const p = computeDropdownPosition({ top: 100, left: 100, width: 120, bottom: 130 }, desktop);
    expect(p.width).toBe(420);
  });

  it("width matches the trigger when the trigger is wider than the preferred width", () => {
    const p = computeDropdownPosition({ top: 100, left: 100, width: 600, bottom: 130 }, desktop);
    expect(p.width).toBe(600);
  });

  it("on a narrow viewport the panel is nearly full width and never overflows horizontally", () => {
    const p = computeDropdownPosition({ top: 100, left: 10, width: 300, bottom: 130 }, narrow);
    expect(p.width).toBe(narrow.width - 28); // full minus both edges
    expect(p.left).toBe(14);
    expect(p.left + p.width).toBeLessThanOrEqual(narrow.width - 14);
  });

  it("clamps left so a right-edge trigger does not push the panel off-screen", () => {
    const p = computeDropdownPosition({ top: 100, left: 1300, width: 200, bottom: 130 }, desktop);
    expect(p.left + p.width).toBeLessThanOrEqual(desktop.width - 14);
    expect(p.left).toBeGreaterThanOrEqual(14);
  });

  it("caps maxHeight to min(60vh, 520)", () => {
    const p = computeDropdownPosition({ top: 50, left: 100, width: 260, bottom: 80 }, { width: 1440, height: 1200 });
    expect(p.maxHeight).toBeLessThanOrEqual(520);
  });
});
