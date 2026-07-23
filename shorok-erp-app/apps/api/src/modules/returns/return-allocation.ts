import { Decimal } from "decimal.js";

/**
 * Deterministic value allocation for partial/full returns (returns spec §7/§8/§12).
 *
 * A return is priced from the ORIGINAL invoice line's historical economics —
 * never current prices/costs. Each amount is allocated by the metre ratio and
 * rounded HALF_UP to 2 dp, EXCEPT the FINAL return of a line (the one that
 * brings cumulative returned metres up to the original metres): that one takes
 * the exact residual = original − Σ(already confirmed). This makes the sum of
 * all partial returns reconcile to the original line to the cent, with no drift.
 */

const ROUND: Decimal.Rounding = Decimal.ROUND_HALF_UP;
const r2 = (x: Decimal) => x.toDecimalPlaces(2, ROUND);
const r4 = (x: Decimal) => x.toDecimalPlaces(4, ROUND);

export interface OriginalLineEconomics {
  meters: Decimal;   // M0 — original returnable metres
  boards: Decimal;   // original operational board/piece count
  gross: Decimal;    // G0 = metres × unitPrice (ex-VAT, before discount)
  discount: Decimal; // D0
  net: Decimal;      // N0 = lineTotal (= G0 − D0)
  lineTax: Decimal;  // round(N0 × taxRate/100, 2)
  lineCogs: Decimal; // C0 — historical COGS for the whole original line
}

export interface AlreadyReturned {
  meters: Decimal;
  boards: Decimal;
  gross: Decimal;
  discount: Decimal;
  net: Decimal;
  tax: Decimal;
  cogs: Decimal;
}

export interface AllocatedReturn {
  meters: Decimal;
  boards: Decimal;
  gross: Decimal;
  discount: Decimal;
  net: Decimal;
  tax: Decimal;
  total: Decimal;
  cogs: Decimal;
  isFinal: boolean;
}

export const zeroAlready = (): AlreadyReturned => ({
  meters: new Decimal(0), boards: new Decimal(0), gross: new Decimal(0),
  discount: new Decimal(0), net: new Decimal(0), tax: new Decimal(0), cogs: new Decimal(0),
});

/**
 * @param o                original line economics
 * @param already          Σ of already-CONFIRMED returns for this original line
 * @param requestedMeters  metres being returned now (validated ≤ remaining upstream)
 * @param requestedBoards  operational boards to return now; when null, derived
 *                         (proportional, or the exact board residual on the final return)
 */
export function allocateReturn(
  o: OriginalLineEconomics,
  already: AlreadyReturned,
  requestedMeters: Decimal,
  requestedBoards: Decimal | null,
): AllocatedReturn {
  const cumulativeMeters = already.meters.plus(requestedMeters);
  // Final iff this return brings cumulative returned metres up to the original.
  const isFinal = r4(cumulativeMeters).gte(r4(o.meters));
  const ratio = o.meters.gt(0) ? requestedMeters.div(o.meters) : new Decimal(0);

  const amt = (total: Decimal, alreadyX: Decimal) =>
    isFinal ? total.minus(alreadyX) : r2(total.mul(ratio));

  const gross = amt(o.gross, already.gross);
  const discount = amt(o.discount, already.discount);
  const net = gross.minus(discount);          // keeps net = gross − discount exactly
  const tax = amt(o.lineTax, already.tax);
  const total = net.plus(tax);
  const cogs = amt(o.lineCogs, already.cogs);

  const boards = requestedBoards != null
    ? requestedBoards
    : isFinal
      ? o.boards.minus(already.boards)         // exact board residual on the final return
      : r4(o.boards.mul(ratio));

  return { meters: requestedMeters, boards, gross, discount, net, tax, total, cogs, isFinal };
}
