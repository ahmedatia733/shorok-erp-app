import { Decimal } from "decimal.js";
import type { OrderStatus } from "@shorok/shared";
import { InvalidStateTransitionError } from "../../common/errors/api-errors";

/**
 * Allowed CustomerOrder status transitions, per `specs/main/data-model.md`.
 * The map is the single source of truth — any code that needs to flip an
 * order's status MUST go through `assertTransition(from, to)`.
 *
 * Notes:
 *  - DRAFT → CANCELLED is intentionally NOT allowed: drafts cannot be
 *    cancelled per the spec; the only ways out of DRAFT are confirm or
 *    rejection-via-price-approval.
 *  - "Self transitions" (e.g., CONFIRMED → CONFIRMED) are NOT allowed; the
 *    caller is expected to skip the assertion when no status change occurs
 *    (e.g., a collection on a still-partially-paid order).
 *  - The OWNER-only constraint on cancellation from PARTIALLY_COLLECTED
 *    and PAID is enforced in the cancel controller, not here. The state
 *    machine is RBAC-agnostic.
 */
const ALLOWED: Readonly<Record<OrderStatus, ReadonlyArray<OrderStatus>>> = {
  DRAFT: ["PENDING_PRICE_APPROVAL", "CONFIRMED"],
  PENDING_PRICE_APPROVAL: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PARTIALLY_COLLECTED", "PAID", "CANCELLED"],
  PARTIALLY_COLLECTED: ["PAID", "CANCELLED"],
  PAID: ["CANCELLED"],
  CANCELLED: [],
};

export const OrderStatusMachine = {
  canTransition(from: OrderStatus, to: OrderStatus): boolean {
    return (ALLOWED[from] as ReadonlyArray<OrderStatus>).includes(to);
  },

  assertTransition(from: OrderStatus, to: OrderStatus): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidStateTransitionError({ from, to });
    }
  },

  /** Compute the post-collection status given the order's required vs collected amounts.
   *  Used after confirm and after each new collection. Caller still asserts
   *  the transition; this just picks the target. Uses decimal.js so cents
   *  comparisons never get burned by float drift (Constitution Principle I). */
  classifyAfterCollection(
    requiredAmount: string,
    collectedAmount: string,
  ): "CONFIRMED" | "PARTIALLY_COLLECTED" | "PAID" {
    const collected = new Decimal(collectedAmount);
    const required = new Decimal(requiredAmount);
    if (collected.lte(0)) return "CONFIRMED";
    if (collected.gte(required)) return "PAID";
    return "PARTIALLY_COLLECTED";
  },
} as const;
