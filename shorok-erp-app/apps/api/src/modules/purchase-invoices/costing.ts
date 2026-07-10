import { Decimal } from "decimal.js";

/**
 * Moving weighted-average cost (WAC), Phase 3A.
 *
 * newAvg = (onHand * oldAvg + qty * unitCost) / (onHand + qty)
 *
 * `onHand` is the quantity on hand BEFORE this receipt (in the same unit the
 * cost is expressed per — here, boards). When there is nothing on hand yet
 * (onHand + qty <= 0), the new average is simply the incoming unit cost.
 *
 * Pure and unit-tested. avg_cost is server-maintained only and, per the
 * approved Phase 3A decision, starts at 0 and builds forward — historical
 * opening cost is a Phase 4 concern.
 */
export function weightedAverageCost(
  onHand: Decimal.Value,
  oldAvg: Decimal.Value,
  qty: Decimal.Value,
  unitCost: Decimal.Value,
): Decimal {
  const on = new Decimal(onHand);
  const q = new Decimal(qty);
  const denom = on.add(q);
  if (denom.lte(0)) return new Decimal(unitCost);
  return on.mul(oldAvg).add(q.mul(unitCost)).div(denom);
}

/**
 * Cost per board for a purchase line = ex-tax line total / boards. VAT is
 * recoverable input tax and is excluded from inventory cost basis. Returns 0
 * when there are no boards (guards divide-by-zero; such lines are skipped).
 */
export function unitCostPerBoard(lineTotalExTax: Decimal.Value, boards: Decimal.Value): Decimal {
  const b = new Decimal(boards);
  if (b.lte(0)) return new Decimal(0);
  return new Decimal(lineTotalExTax).div(b);
}
