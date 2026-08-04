import { Decimal } from "decimal.js";

/**
 * Deterministic moving-average valuation replay.
 *
 * Shorok values stock as a single GLOBAL pool per ProductVariant:
 *
 *   poolValue = Σ(metersOnHand across every branch) × avgCostPerMeter
 *
 * That is not an invention here — it is literally what the existing return
 * services compute before they rewrite `avgCostPerMeter`
 * (`sales-returns.service.ts` / `purchase-returns.service.ts`). This module
 * reproduces that model over a movement timeline so a purchase revision can
 * answer "what would the WAC and the issued costs have been if this receipt had
 * always carried the revised quantity and value?".
 *
 * ── Why a replay has to start from TODAY and walk backwards ────────────────
 * `inventory_movements` records boards and metres only — no cost, no value —
 * and opening stock arrived as a valueless COUNT_CORRECTION. A replay that
 * started at zero could therefore never reconstruct today's real WAC. What IS
 * exactly known is the present state (metersOnHand, avgCostPerMeter), and each
 * event's inverse is closed-form under a moving average. So we rewind from the
 * known present to the anchor point, then replay forward. Rewind and replay are
 * exact inverses, and `replayCurrentFacts` proves it numerically on every call
 * instead of asserting it in a comment.
 *
 * ── Event semantics ────────────────────────────────────────────────────────
 *   RECEIPT       value in,  magnitude known (purchase line total, ex-tax)
 *   VALUE_IN      value in,  magnitude known (sales return at historical COGS)
 *   VALUE_OUT     value out, magnitude known (purchase return at historical cost)
 *   ISSUE         value out at the PREVAILING pool rate (a sale) — WAC unchanged
 *   QUANTITY_ONLY count correction / adjustment — WAC unchanged by definition,
 *                 because no code path in the system revalues on those
 *
 * All arithmetic is Decimal. Nothing is rounded until a caller formats it.
 */

export type ValuationEventKind = "RECEIPT" | "VALUE_IN" | "VALUE_OUT" | "ISSUE" | "QUANTITY_ONLY";

export interface ValuationEvent {
  /** Stable identity — the movement row, or a synthetic id for a substitution. */
  id: string;
  /** Canonical chronology. `inventory_movements.created_at` is the only date the model has. */
  at: Date;
  kind: ValuationEventKind;
  /** SIGNED metres exactly as recorded: positive in, negative out. */
  meters: Decimal;
  /** Absolute value magnitude for RECEIPT / VALUE_IN / VALUE_OUT. */
  value: Decimal | null;
  /** Recorded per-metre issue cost for an ISSUE, when the source line snapshotted one. */
  recordedIssueRate: Decimal | null;
  /** Free-form provenance for the evidence payload. */
  sourceRef: string | null;
}

export interface PoolState {
  meters: Decimal;
  value: Decimal;
}

export interface ForwardReplayResult {
  ending: PoolState;
  endingWacPerMeter: Decimal;
  /** Total value issued out through ISSUE events, i.e. replayed COGS. */
  issuedValue: Decimal;
  /** Per-event issued value, in event order, for evidence and cross-checks. */
  issues: Array<{ id: string; meters: Decimal; rate: Decimal; value: Decimal; recordedRate: Decimal | null }>;
  /** Σ known value entering (RECEIPT + VALUE_IN). */
  knownValueIn: Decimal;
  /** Σ known value leaving (VALUE_OUT). */
  knownValueOut: Decimal;
  /**
   * SIGNED net value moved by quantity-only events (counts, adjustments,
   * cancel compensations), which carry no value of their own and therefore
   * move whatever the prevailing rate happens to be. Positive = value entered.
   * It is a separate bucket because a cost revision changes that rate, and the
   * difference has to be accounted for somewhere rather than quietly absorbed.
   */
  quantityOnlyValue: Decimal;
}

export class ValuationReplayError extends Error {
  constructor(
    readonly code: string,
    readonly context: Record<string, string>,
  ) {
    super(`${code} ${JSON.stringify(context)}`);
    this.name = "ValuationReplayError";
  }
}

/** Canonical deterministic order: effective timestamp, then stable id. */
export function orderEvents(events: ValuationEvent[]): ValuationEvent[] {
  return [...events].sort((a, b) => {
    const t = a.at.getTime() - b.at.getTime();
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

const ZERO = new Decimal(0);

function rateOf(state: PoolState): Decimal {
  return state.meters.gt(0) ? state.value.div(state.meters) : ZERO;
}

/**
 * Walk BACKWARDS over `events` (which must already be in canonical order) from
 * the known present state, returning the pool state immediately BEFORE the
 * first event in the list.
 */
export function rewind(present: PoolState, events: ValuationEvent[]): PoolState {
  let state: PoolState = { meters: present.meters, value: present.value };

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    const before: PoolState = { meters: state.meters.minus(e.meters), value: ZERO };

    switch (e.kind) {
      case "RECEIPT":
      case "VALUE_IN":
        before.value = state.value.minus(requireValue(e));
        break;
      case "VALUE_OUT":
        before.value = state.value.plus(requireValue(e));
        break;
      case "ISSUE":
      case "QUANTITY_ONLY": {
        // The rate is unchanged across these, so the earlier value is simply
        // the earlier quantity at the same rate. When nothing is left on hand
        // the rate is unrecoverable from the pool, so fall back to the cost the
        // document itself recorded; if there is none either, the timeline
        // cannot be rewound safely and we say so rather than guess.
        if (state.meters.gt(0)) {
          before.value = before.meters.times(state.value.div(state.meters));
        } else if (e.recordedIssueRate != null) {
          before.value = before.meters.times(e.recordedIssueRate);
        } else if (state.value.isZero()) {
          before.value = ZERO;
        } else {
          throw new ValuationReplayError("replay_rate_unrecoverable", { eventId: e.id });
        }
        break;
      }
    }

    if (before.meters.isNegative()) {
      throw new ValuationReplayError("replay_negative_quantity", {
        eventId: e.id,
        meters: before.meters.toFixed(4),
      });
    }
    // Half a piastre of slack: the stored WAC is 4 dp, so qty × rate can land a
    // hair below zero on a fully-drained pool without anything being wrong.
    if (before.value.lt(new Decimal("-0.005"))) {
      throw new ValuationReplayError("replay_negative_value", {
        eventId: e.id,
        value: before.value.toFixed(4),
      });
    }
    state = before;
  }
  return state;
}

/** Replay `events` forward from `start`. */
export function replay(start: PoolState, events: ValuationEvent[]): ForwardReplayResult {
  let meters = start.meters;
  let value = start.value;
  let issuedValue = ZERO;
  let knownValueIn = ZERO;
  let knownValueOut = ZERO;
  let quantityOnlyValue = ZERO;
  const issues: ForwardReplayResult["issues"] = [];

  for (const e of events) {
    switch (e.kind) {
      case "RECEIPT":
      case "VALUE_IN": {
        const v = requireValue(e);
        meters = meters.plus(e.meters);
        value = value.plus(v);
        knownValueIn = knownValueIn.plus(v);
        break;
      }
      case "VALUE_OUT": {
        const v = requireValue(e);
        meters = meters.plus(e.meters);
        value = value.minus(v);
        knownValueOut = knownValueOut.plus(v);
        break;
      }
      case "ISSUE": {
        const rate = rateOf({ meters, value });
        const cost = e.meters.negated().times(rate);
        meters = meters.plus(e.meters);
        value = value.minus(cost);
        issuedValue = issuedValue.plus(cost);
        issues.push({ id: e.id, meters: e.meters, rate, value: cost, recordedRate: e.recordedIssueRate });
        break;
      }
      case "QUANTITY_ONLY": {
        const rate = rateOf({ meters, value });
        const moved = e.meters.times(rate);
        meters = meters.plus(e.meters);
        value = value.plus(moved);
        quantityOnlyValue = quantityOnlyValue.plus(moved);
        break;
      }
    }

    if (meters.isNegative()) {
      throw new ValuationReplayError("replay_negative_quantity", {
        eventId: e.id,
        meters: meters.toFixed(4),
      });
    }
  }

  return {
    ending: { meters, value },
    endingWacPerMeter: rateOf({ meters, value }),
    issuedValue,
    issues,
    knownValueIn,
    knownValueOut,
    quantityOnlyValue,
  };
}

function requireValue(e: ValuationEvent): Decimal {
  if (e.value == null) {
    throw new ValuationReplayError("replay_event_missing_value", { eventId: e.id, kind: e.kind });
  }
  return e.value;
}

export interface ReplayComparison {
  anchor: PoolState;
  current: ForwardReplayResult;
  revised: ForwardReplayResult;
  /** revised ending value − current ending value. */
  inventoryValueDelta: Decimal;
  /** revised issued value − current issued value. Positive = COGS understated. */
  cogsDelta: Decimal;
  /**
   * Change in the value carried out (or in) by valueless movements — counts,
   * adjustments, cancel compensations — because the rate they moved at changed.
   * Signed the same way as `quantityOnlyValue`: positive = more value entered.
   */
  adjustmentDelta: Decimal;
  /** Change in the known value entering — i.e. what the revised receipt is worth. */
  knownValueInDelta: Decimal;
  /** Replaying the unrevised facts landed exactly back on the known present. */
  reproducedPresent: boolean;
  /**
   * Δin − Δout + Δquantity-only = Δending. Every part of a cost change lands in
   * exactly one of stock, cost of sales, or an inventory difference — nothing
   * is absorbed silently.
   */
  conservationHolds: boolean;
  /** Sales whose replayed rate disagrees with the cost they actually posted. */
  issueRateMismatches: Array<{ id: string; replayed: string; recorded: string }>;
}

/**
 * The whole calculation in one call: rewind to the anchor, replay both ways,
 * and hand back the deltas together with the evidence that the model reproduced
 * reality. `presentMeters`/`presentWac` are today's stored facts.
 */
export function compareTimelines(input: {
  presentMeters: Decimal;
  presentWacPerMeter: Decimal;
  /** Canonical-ordered events from the replay start to now, as they happened. */
  currentEvents: ValuationEvent[];
  /** The same window with the revised facts substituted in place. */
  revisedEvents: ValuationEvent[];
}): ReplayComparison {
  const present: PoolState = {
    meters: input.presentMeters,
    value: input.presentMeters.times(input.presentWacPerMeter),
  };

  const currentOrdered = orderEvents(input.currentEvents);
  const revisedOrdered = orderEvents(input.revisedEvents);

  const anchor = rewind(present, currentOrdered);
  const current = replay(anchor, currentOrdered);
  const revised = replay(anchor, revisedOrdered);

  const TOL = new Decimal("0.01");
  const reproducedPresent =
    current.ending.meters.minus(present.meters).abs().lte(new Decimal("0.0001")) &&
    current.ending.value.minus(present.value).abs().lte(TOL);

  const knownValueInDelta = revised.knownValueIn.minus(current.knownValueIn);
  const knownOutDelta = revised.knownValueOut.minus(current.knownValueOut);
  const issuedDelta = revised.issuedValue.minus(current.issuedValue);
  const adjustmentDelta = revised.quantityOnlyValue.minus(current.quantityOnlyValue);
  const deltaEnding = revised.ending.value.minus(current.ending.value);
  const conservationHolds = knownValueInDelta
    .minus(knownOutDelta)
    .minus(issuedDelta)
    .plus(adjustmentDelta)
    .minus(deltaEnding)
    .abs()
    .lte(TOL);

  const issueRateMismatches = current.issues
    .filter((i) => i.recordedRate != null && i.rate.minus(i.recordedRate).abs().gt(new Decimal("0.0001")))
    .map((i) => ({ id: i.id, replayed: i.rate.toFixed(4), recorded: i.recordedRate!.toFixed(4) }));

  return {
    anchor,
    current,
    revised,
    inventoryValueDelta: deltaEnding,
    cogsDelta: issuedDelta,
    adjustmentDelta,
    knownValueInDelta,
    reproducedPresent,
    conservationHolds,
    issueRateMismatches,
  };
}
