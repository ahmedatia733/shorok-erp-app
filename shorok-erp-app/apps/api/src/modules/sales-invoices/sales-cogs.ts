import { Decimal } from "decimal.js";

/**
 * Cost of goods sold for a sales line (Phase 3B).
 *
 * Inventory is tracked in boards; a sales line quantity is in metres. The
 * boards consumed = quantityMeters / sizeMetersPerBoard, and the cost is that
 * many boards × the variant's weighted-average cost per board (avg_cost).
 *
 * COGS comes ONLY from avg_cost — never from the user-entered cost_price.
 * When avg_cost is 0 (an item never purchased through Phase 3A, so it has no
 * cost basis yet), COGS is 0 and the caller skips the COGS entry entirely
 * (a zero-value entry would violate the PostingEngine debit-XOR-credit
 * invariant). Opening cost for such stock is a Phase 4 concern.
 *
 * Pure and unit-tested.
 */
export function lineCogs(
  quantityMeters: Decimal.Value,
  sizeMetersPerBoard: Decimal.Value,
  avgCostPerBoard: Decimal.Value,
): Decimal {
  const size = new Decimal(sizeMetersPerBoard);
  if (size.lte(0)) return new Decimal(0);
  const boards = new Decimal(quantityMeters).div(size);
  return boards.mul(avgCostPerBoard);
}
