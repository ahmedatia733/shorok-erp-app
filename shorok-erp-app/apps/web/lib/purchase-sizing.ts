/**
 * Purchase-invoice board sizing helpers (Phase 1 stabilization).
 *
 * Business meaning (confirmed against the current data model, 2026-07-08):
 * a "board" (لوح) has an AREA. The standard sizes are كبير = 5.25 and
 * صغير = 4; a custom board is طول × عرض. The line's total is
 * (number of boards) × (area per board).
 *
 * NAMING MISMATCH TO FIX IN PHASE 7: the backend column is named
 * `size_meters_per_board` / `metersQuantity` (linear-meters language) but
 * the business quantity is a board AREA in square metres (م²). We keep the
 * field names as-is for now and only correct the UI labels + display; the
 * rename belongs to the Phase 7 productization work (UoM configuration).
 */

export const BOARD_AREA_LARGE = 5.25; // كبير — م² لكل لوح
export const BOARD_AREA_SMALL = 4.0; // صغير — م² لكل لوح

export type SizeChoice = "K" | "S" | "";

/**
 * Area (م²) of a single board.
 * Custom طول×عرض overrides the standard كبير/صغير choice; when neither is
 * provided, falls back to the product variant's stored per-board size.
 */
export function boardArea(
  sizeChoice: SizeChoice,
  customL: number,
  customW: number,
  variantSize: number,
): number {
  if (customL > 0 && customW > 0) return customL * customW;
  if (sizeChoice === "K") return BOARD_AREA_LARGE;
  if (sizeChoice === "S") return BOARD_AREA_SMALL;
  return variantSize > 0 ? variantSize : 0;
}

/** Total line area (م²) = number of boards × area per board. */
export function totalArea(boards: number, areaPerBoard: number): number {
  if (boards <= 0 || areaPerBoard <= 0) return 0;
  return boards * areaPerBoard;
}
