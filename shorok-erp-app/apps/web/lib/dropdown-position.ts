/**
 * Pure viewport positioning for a portal dropdown rendered with position:fixed.
 * Decides down/up placement, clamps width, and keeps the panel inside the
 * viewport with an edge margin — so parent overflow (table/card/modal) can
 * never clip it. Kept framework-free so it is unit-testable without a DOM.
 */
export interface Rect {
  top: number;
  left: number;
  width: number;
  bottom: number;
}
export interface Viewport {
  width: number;
  height: number;
}
export interface DropdownPosition {
  placement: "down" | "up";
  left: number;
  width: number;
  maxHeight: number;
  /** set when placement === "down" (fixed top) */
  top?: number;
  /** set when placement === "up" (fixed distance from viewport bottom) */
  bottom?: number;
}

export function computeDropdownPosition(
  trigger: Rect,
  vp: Viewport,
  opts: { edge?: number; gap?: number; maxPanel?: number; minPanel?: number; preferredWidth?: number } = {},
): DropdownPosition {
  const edge = opts.edge ?? 14;
  const gap = opts.gap ?? 6;
  const maxPanel = opts.maxPanel ?? Math.min(vp.height * 0.6, 520);
  const minPanel = Math.min(opts.minPanel ?? 280, maxPanel);
  const preferredWidth = opts.preferredWidth ?? 420;

  const spaceBelow = vp.height - trigger.bottom - edge;
  const spaceAbove = trigger.top - edge;
  // Open upward only when below is too short AND above is genuinely roomier.
  const openUp = spaceBelow < minPanel && spaceAbove > spaceBelow;

  // Width: at least the trigger, prefer 420 on desktop, never wider than the
  // viewport minus both edges (so a narrow screen uses ~full width, no h-scroll).
  const width = Math.min(Math.max(trigger.width, preferredWidth), Math.max(0, vp.width - 2 * edge));

  // Left: align to trigger, then clamp inside [edge, vp.width - edge - width].
  let left = trigger.left;
  left = Math.min(left, vp.width - edge - width);
  left = Math.max(edge, left);

  if (openUp) {
    return {
      placement: "up",
      left,
      width,
      maxHeight: Math.min(maxPanel, Math.max(0, spaceAbove)),
      bottom: vp.height - trigger.top + gap,
    };
  }
  return {
    placement: "down",
    left,
    width,
    maxHeight: Math.min(maxPanel, Math.max(0, spaceBelow)),
    top: trigger.bottom + gap,
  };
}
