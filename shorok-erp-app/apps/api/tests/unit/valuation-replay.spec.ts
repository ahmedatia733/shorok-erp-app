/**
 * The valuation replay is the safety argument behind confirmed PURCHASE
 * revisions, so its maths is pinned here independently of any database.
 *
 * The two properties that matter:
 *   1. rewind() and replay() are exact inverses — otherwise the anchor the
 *      whole calculation hangs from would be fiction;
 *   2. Δ(value in) − Δ(value out) = Δ(ending value) — otherwise the adjustment
 *      journal would silently lose or invent money.
 */
import { Decimal } from "decimal.js";
import {
  compareTimelines,
  orderEvents,
  replay,
  rewind,
  ValuationReplayError,
  type ValuationEvent,
} from "../../src/modules/invoice-revisions/valuation-replay";

const at = (iso: string) => new Date(iso);
const d = (v: string) => new Decimal(v);

const receipt = (id: string, iso: string, meters: string, value: string): ValuationEvent => ({
  id, at: at(iso), kind: "RECEIPT", meters: d(meters), value: d(value), recordedIssueRate: null, sourceRef: null,
});
const issueEv = (id: string, iso: string, meters: string, recorded?: string): ValuationEvent => ({
  id, at: at(iso), kind: "ISSUE", meters: d(meters), value: null,
  recordedIssueRate: recorded != null ? d(recorded) : null, sourceRef: null,
});
const countEv = (id: string, iso: string, meters: string): ValuationEvent => ({
  id, at: at(iso), kind: "QUANTITY_ONLY", meters: d(meters), value: null, recordedIssueRate: null, sourceRef: null,
});
const valueIn = (id: string, iso: string, meters: string, value: string): ValuationEvent => ({
  id, at: at(iso), kind: "VALUE_IN", meters: d(meters), value: d(value), recordedIssueRate: null, sourceRef: null,
});
const valueOut = (id: string, iso: string, meters: string, value: string): ValuationEvent => ({
  id, at: at(iso), kind: "VALUE_OUT", meters: d(meters), value: d(value), recordedIssueRate: null, sourceRef: null,
});

describe("valuation replay — ordering", () => {
  it("orders by effective timestamp, then by stable id", () => {
    const a = receipt("b", "2026-01-02T00:00:00Z", "1", "1");
    const b = receipt("a", "2026-01-02T00:00:00Z", "1", "1");
    const c = receipt("z", "2026-01-01T00:00:00Z", "1", "1");
    expect(orderEvents([a, b, c]).map((e) => e.id)).toEqual(["z", "a", "b"]);
  });

  it("does not mutate the caller's array", () => {
    const list = [receipt("b", "2026-01-02T00:00:00Z", "1", "1"), receipt("a", "2026-01-01T00:00:00Z", "1", "1")];
    orderEvents(list);
    expect(list.map((e) => e.id)).toEqual(["b", "a"]);
  });
});

describe("valuation replay — forward maths", () => {
  it("a receipt into an empty pool sets the rate to the incoming cost", () => {
    const r = replay({ meters: d("0"), value: d("0") }, [receipt("r1", "2026-01-01T00:00:00Z", "100", "50000")]);
    expect(r.endingWacPerMeter.toFixed(4)).toBe("500.0000");
    expect(r.ending.meters.toFixed(4)).toBe("100.0000");
  });

  it("a second receipt at a different cost produces the weighted average", () => {
    const r = replay({ meters: d("0"), value: d("0") }, [
      receipt("r1", "2026-01-01T00:00:00Z", "100", "50000"), // 500/m
      receipt("r2", "2026-01-02T00:00:00Z", "100", "60000"), // 600/m
    ]);
    expect(r.endingWacPerMeter.toFixed(4)).toBe("550.0000");
  });

  it("a sale issues at the prevailing rate and leaves the rate untouched", () => {
    const r = replay({ meters: d("100"), value: d("50000") }, [issueEv("s1", "2026-02-01T00:00:00Z", "-40")]);
    expect(r.endingWacPerMeter.toFixed(4)).toBe("500.0000");
    expect(r.issuedValue.toFixed(2)).toBe("20000.00");
    expect(r.ending.meters.toFixed(4)).toBe("60.0000");
  });

  it("a quantity-only correction moves value at the prevailing rate", () => {
    const r = replay({ meters: d("100"), value: d("50000") }, [countEv("c1", "2026-02-01T00:00:00Z", "10")]);
    expect(r.endingWacPerMeter.toFixed(4)).toBe("500.0000");
    expect(r.ending.value.toFixed(2)).toBe("55000.00");
  });

  it("a sale return re-enters at its recorded historical cost, changing the rate", () => {
    // 100 m at 500 on hand, 10 m returns carrying a historical 400/m.
    const r = replay({ meters: d("100"), value: d("50000") }, [valueIn("sr", "2026-02-01T00:00:00Z", "10", "4000")]);
    expect(r.ending.meters.toFixed(4)).toBe("110.0000");
    expect(r.endingWacPerMeter.toFixed(4)).toBe("490.9091");
  });

  it("a purchase return leaves at its recorded historical cost", () => {
    const r = replay({ meters: d("100"), value: d("50000") }, [valueOut("pr", "2026-02-01T00:00:00Z", "-10", "4000")]);
    expect(r.ending.meters.toFixed(4)).toBe("90.0000");
    expect(r.ending.value.toFixed(2)).toBe("46000.00");
  });

  it("refuses to drive the quantity negative", () => {
    expect(() => replay({ meters: d("5"), value: d("2500") }, [issueEv("s", "2026-02-01T00:00:00Z", "-10")]))
      .toThrow(ValuationReplayError);
  });

  it("refuses an event that claims a known value but carries none", () => {
    const broken: ValuationEvent = { id: "x", at: at("2026-01-01T00:00:00Z"), kind: "RECEIPT", meters: d("1"), value: null, recordedIssueRate: null, sourceRef: null };
    expect(() => replay({ meters: d("0"), value: d("0") }, [broken])).toThrow(/replay_event_missing_value/);
  });
});

describe("valuation replay — rewind is the exact inverse of replay", () => {
  const timeline: ValuationEvent[] = [
    receipt("r1", "2026-01-01T00:00:00Z", "100", "50000"),
    issueEv("s1", "2026-01-05T00:00:00Z", "-30", "500"),
    countEv("c1", "2026-01-06T00:00:00Z", "5"),
    receipt("r2", "2026-01-10T00:00:00Z", "50", "30000"),
    issueEv("s2", "2026-01-20T00:00:00Z", "-25"),
    valueIn("sr1", "2026-01-25T00:00:00Z", "10", "5200"),
    valueOut("pr1", "2026-01-28T00:00:00Z", "-8", "4600"),
  ];

  it("round-trips any start state", () => {
    const start = { meters: d("40"), value: d("18000") };
    const end = replay(start, timeline).ending;
    const back = rewind(end, timeline);
    expect(back.meters.minus(start.meters).abs().lte(d("0.0001"))).toBe(true);
    expect(back.value.minus(start.value).abs().lte(d("0.0001"))).toBe(true);
  });

  it("round-trips from a genuinely empty start", () => {
    const start = { meters: d("0"), value: d("0") };
    const end = replay(start, timeline).ending;
    const back = rewind(end, timeline);
    expect(back.meters.toFixed(4)).toBe("0.0000");
    expect(back.value.abs().lte(d("0.0001"))).toBe(true);
  });

  it("refuses to rewind past a point where the pool would go negative", () => {
    expect(() => rewind({ meters: d("1"), value: d("500") }, [receipt("r", "2026-01-01T00:00:00Z", "100", "50000")]))
      .toThrow(/replay_negative_quantity/);
  });

  it("falls back to the document's own recorded rate when the pool is empty", () => {
    // Everything was sold: the present pool is 0/0, so the rate is unrecoverable
    // from it and only the sale's own snapshot can supply it.
    const back = rewind({ meters: d("0"), value: d("0") }, [issueEv("s", "2026-02-01T00:00:00Z", "-20", "480")]);
    expect(back.meters.toFixed(4)).toBe("20.0000");
    expect(back.value.toFixed(2)).toBe("9600.00");
  });
});

describe("valuation replay — comparing a revised purchase against history", () => {
  /** 100 m bought at 500, 60 m later sold, 40 m still on hand → WAC 500. */
  const history: ValuationEvent[] = [
    receipt("mv:r1", "2026-01-01T00:00:00Z", "100", "50000"),
    issueEv("mv:s1", "2026-02-01T00:00:00Z", "-60", "500"),
  ];
  const revisedTo = (meters: string, value: string): ValuationEvent[] => [
    receipt("0000revised:v", "2026-01-01T00:00:00Z", meters, value),
    issueEv("mv:s1", "2026-02-01T00:00:00Z", "-60", "500"),
  ];

  it("reproduces the present state from the unrevised facts", () => {
    const c = compareTimelines({
      presentMeters: d("40"), presentWacPerMeter: d("500"),
      currentEvents: history, revisedEvents: history,
    });
    expect(c.reproducedPresent).toBe(true);
    expect(c.inventoryValueDelta.toFixed(2)).toBe("0.00");
    expect(c.cogsDelta.toFixed(2)).toBe("0.00");
  });

  it("splits a cost increase between remaining stock and already-sold COGS", () => {
    // Same 100 m, now costing 55 000 instead of 50 000 → +5 000 in total.
    // 60 of the 100 m were sold, so 60% belongs in COGS and 40% in stock.
    const c = compareTimelines({
      presentMeters: d("40"), presentWacPerMeter: d("500"),
      currentEvents: history, revisedEvents: revisedTo("100", "55000"),
    });
    expect(c.cogsDelta.toFixed(2)).toBe("3000.00");
    expect(c.inventoryValueDelta.toFixed(2)).toBe("2000.00");
    expect(c.revised.endingWacPerMeter.toFixed(4)).toBe("550.0000");
    expect(c.conservationHolds).toBe(true);
    // The identity the adjustment journal relies on.
    expect(c.inventoryValueDelta.plus(c.cogsDelta).toFixed(2)).toBe("5000.00");
  });

  it("splits a cost decrease symmetrically", () => {
    const c = compareTimelines({
      presentMeters: d("40"), presentWacPerMeter: d("500"),
      currentEvents: history, revisedEvents: revisedTo("100", "45000"),
    });
    expect(c.cogsDelta.toFixed(2)).toBe("-3000.00");
    expect(c.inventoryValueDelta.toFixed(2)).toBe("-2000.00");
    expect(c.conservationHolds).toBe(true);
  });

  it("handles a quantity increase — more stock at the same rate, COGS unchanged", () => {
    // 120 m for 60 000 is still 500/m, so nothing that was already sold moves.
    const c = compareTimelines({
      presentMeters: d("40"), presentWacPerMeter: d("500"),
      currentEvents: history, revisedEvents: revisedTo("120", "60000"),
    });
    expect(c.cogsDelta.toFixed(2)).toBe("0.00");
    expect(c.revised.endingWacPerMeter.toFixed(4)).toBe("500.0000");
    expect(c.revised.ending.meters.toFixed(4)).toBe("60.0000");
    expect(c.conservationHolds).toBe(true);
  });

  it("keeps working when later purchases sit between the receipt and today", () => {
    const withLater: ValuationEvent[] = [
      receipt("mv:r1", "2026-01-01T00:00:00Z", "100", "50000"),
      issueEv("mv:s1", "2026-02-01T00:00:00Z", "-60", "500"),
      receipt("mv:r2", "2026-03-01T00:00:00Z", "100", "60000"),
      issueEv("mv:s2", "2026-04-01T00:00:00Z", "-50"),
    ];
    const revised: ValuationEvent[] = [
      receipt("0000revised:v", "2026-01-01T00:00:00Z", "100", "55000"),
      ...withLater.slice(1),
    ];
    // present = 100 − 60 + 100 − 50 = 90 m; pool = 50000 − 30000 + 60000 − issue
    const present = replay({ meters: d("0"), value: d("0") }, withLater);
    const c = compareTimelines({
      presentMeters: present.ending.meters,
      presentWacPerMeter: present.endingWacPerMeter,
      currentEvents: withLater,
      revisedEvents: revised,
    });
    expect(c.reproducedPresent).toBe(true);
    expect(c.conservationHolds).toBe(true);
    expect(c.inventoryValueDelta.plus(c.cogsDelta).toFixed(2)).toBe("5000.00");
  });

  it("keeps working across returns and count corrections in the window", () => {
    const busy: ValuationEvent[] = [
      receipt("mv:r1", "2026-01-01T00:00:00Z", "100", "50000"),
      issueEv("mv:s1", "2026-02-01T00:00:00Z", "-60", "500"),
      valueIn("mv:sr1", "2026-02-10T00:00:00Z", "10", "5000"),
      countEv("mv:c1", "2026-02-15T00:00:00Z", "-2"),
      valueOut("mv:pr1", "2026-02-20T00:00:00Z", "-5", "2500"),
    ];
    const revised: ValuationEvent[] = [receipt("0000revised:v", "2026-01-01T00:00:00Z", "100", "55000"), ...busy.slice(1)];
    const present = replay({ meters: d("0"), value: d("0") }, busy);
    const c = compareTimelines({
      presentMeters: present.ending.meters,
      presentWacPerMeter: present.endingWacPerMeter,
      currentEvents: busy,
      revisedEvents: revised,
    });
    expect(c.reproducedPresent).toBe(true);
    expect(c.conservationHolds).toBe(true);
    // The count correction took 2 m out at a rate that the revision raised by
    // 40/m, so 80 of the extra 5 000 left through the inventory difference
    // rather than through stock or cost of sales. It is a THIRD bucket, and the
    // three still add back to exactly what came in.
    expect(c.adjustmentDelta.toFixed(2)).toBe("-80.00");
    expect(c.inventoryValueDelta.plus(c.cogsDelta).minus(c.adjustmentDelta).toFixed(2)).toBe("5000.00");
    expect(c.knownValueInDelta.toFixed(2)).toBe("5000.00");
  });

  it("has no inventory-difference bucket when nothing valueless moved", () => {
    const c = compareTimelines({
      presentMeters: d("40"), presentWacPerMeter: d("500"),
      currentEvents: history, revisedEvents: revisedTo("100", "55000"),
    });
    expect(c.adjustmentDelta.toFixed(2)).toBe("0.00");
  });

  it("reports sales whose posted cost disagrees with the pooled rate", () => {
    const skewed: ValuationEvent[] = [
      receipt("mv:r1", "2026-01-01T00:00:00Z", "100", "50000"),
      issueEv("mv:s1", "2026-02-01T00:00:00Z", "-60", "410"), // posted 410, pool says 500
    ];
    const c = compareTimelines({
      presentMeters: d("40"), presentWacPerMeter: d("500"),
      currentEvents: skewed, revisedEvents: skewed,
    });
    expect(c.issueRateMismatches).toHaveLength(1);
    expect(c.issueRateMismatches[0]).toMatchObject({ replayed: "500.0000", recorded: "410.0000" });
  });

  it("keeps full precision — no rounding until a caller formats", () => {
    // 262.50 m at 498.8235/m = 130 941.168750, which is NOT a money figure.
    const c = compareTimelines({
      presentMeters: d("262.5"), presentWacPerMeter: d("498.8235"),
      currentEvents: [receipt("mv:r1", "2026-01-01T00:00:00Z", "262.5", "130941.16875")],
      revisedEvents: [receipt("0000revised:v", "2026-01-01T00:00:00Z", "262.5", "130941.16875")],
    });
    expect(c.reproducedPresent).toBe(true);
    expect(c.revised.ending.value.toString()).toContain("130941.16875");
  });
});
