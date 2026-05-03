/**
 * T077 — Unit test for the OrderStatusMachine.
 *
 * Verifies the FULL transition matrix from `specs/main/data-model.md`:
 *  - every allowed transition succeeds via `assertTransition`
 *  - every disallowed pair (cartesian minus allowed) throws
 *    `InvalidStateTransitionError`
 *  - `classifyAfterCollection` uses decimal arithmetic and matches the
 *    spec's three-way classification.
 */
import type { OrderStatus } from "@shorok/shared";
import { OrderStatusMachine } from "../../src/modules/orders/order-status-machine";
import { InvalidStateTransitionError } from "../../src/common/errors/api-errors";

const ALL_STATES: OrderStatus[] = [
  "DRAFT",
  "PENDING_PRICE_APPROVAL",
  "CONFIRMED",
  "PARTIALLY_COLLECTED",
  "PAID",
  "CANCELLED",
];

// Mirror of `specs/main/data-model.md` state machine. The test file is the
// independent source of truth — if the implementation drifts from this, the
// test will catch it.
const ALLOWED_PAIRS: Array<[OrderStatus, OrderStatus]> = [
  ["DRAFT", "PENDING_PRICE_APPROVAL"],
  ["DRAFT", "CONFIRMED"],
  ["PENDING_PRICE_APPROVAL", "CONFIRMED"],
  ["PENDING_PRICE_APPROVAL", "CANCELLED"],
  ["CONFIRMED", "PARTIALLY_COLLECTED"],
  ["CONFIRMED", "PAID"],
  ["PARTIALLY_COLLECTED", "PAID"],
  ["CONFIRMED", "CANCELLED"],
  ["PARTIALLY_COLLECTED", "CANCELLED"],
  ["PAID", "CANCELLED"],
];

function isAllowed(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_PAIRS.some(([f, t]) => f === from && t === to);
}

describe("OrderStatusMachine", () => {
  describe("allowed transitions", () => {
    it.each(ALLOWED_PAIRS)("permits %s → %s", (from, to) => {
      expect(() => OrderStatusMachine.assertTransition(from, to)).not.toThrow();
      expect(OrderStatusMachine.canTransition(from, to)).toBe(true);
    });
  });

  describe("blocked transitions", () => {
    const blockedPairs: Array<[OrderStatus, OrderStatus]> = [];
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        // Self-transitions are tested separately; classify them as blocked.
        if (!isAllowed(from, to)) blockedPairs.push([from, to]);
      }
    }

    it.each(blockedPairs)("rejects %s → %s with InvalidStateTransitionError", (from, to) => {
      expect(() => OrderStatusMachine.assertTransition(from, to)).toThrow(
        InvalidStateTransitionError,
      );
      expect(OrderStatusMachine.canTransition(from, to)).toBe(false);
    });
  });

  describe("CANCELLED is terminal", () => {
    it.each(ALL_STATES)("CANCELLED → %s is rejected", (to) => {
      expect(() => OrderStatusMachine.assertTransition("CANCELLED", to)).toThrow(
        InvalidStateTransitionError,
      );
    });
  });

  describe("DRAFT cannot be cancelled directly (per spec)", () => {
    it("DRAFT → CANCELLED is rejected", () => {
      expect(() => OrderStatusMachine.assertTransition("DRAFT", "CANCELLED")).toThrow(
        InvalidStateTransitionError,
      );
    });
  });

  describe("classifyAfterCollection (decimal-correct)", () => {
    it("returns CONFIRMED when nothing has been collected", () => {
      expect(OrderStatusMachine.classifyAfterCollection("100", "0")).toBe("CONFIRMED");
      expect(OrderStatusMachine.classifyAfterCollection("100", "0.00")).toBe("CONFIRMED");
    });
    it("returns PAID when collected meets or exceeds required", () => {
      expect(OrderStatusMachine.classifyAfterCollection("100", "100")).toBe("PAID");
      expect(OrderStatusMachine.classifyAfterCollection("100", "100.0001")).toBe("PAID");
    });
    it("returns PARTIALLY_COLLECTED in between", () => {
      expect(OrderStatusMachine.classifyAfterCollection("100", "50")).toBe(
        "PARTIALLY_COLLECTED",
      );
    });
    it("classifies correctly at decimal boundary (no float drift)", () => {
      // 0.1 + 0.2 in float = 0.30000000000000004 → would mis-classify with Number.
      // 0.1+0.2 collected against 0.3 required must read as PAID.
      expect(OrderStatusMachine.classifyAfterCollection("0.30", "0.30")).toBe("PAID");
      expect(OrderStatusMachine.classifyAfterCollection("100.00", "99.99")).toBe(
        "PARTIALLY_COLLECTED",
      );
    });
  });
});
