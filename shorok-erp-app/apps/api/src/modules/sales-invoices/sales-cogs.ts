import { Decimal } from "decimal.js";

/**
 * Cost of goods sold for a sales line (Phase 3B).
 *
 * A sales line `quantity` is the number of BOARDS sold; inventory is tracked in
 * boards, so COGS = boards × the variant's weighted-average cost per board
 * (avg_cost). (Per-metre sales pricing does not change the accounting cost
 * basis, which is per board.)
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
  boards: Decimal.Value,
  avgCostPerBoard: Decimal.Value,
): Decimal {
  const b = new Decimal(boards);
  if (b.lte(0)) return new Decimal(0);
  return b.mul(avgCostPerBoard);
}
