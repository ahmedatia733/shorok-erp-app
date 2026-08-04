import { Decimal } from "decimal.js";
import type { RevisionIssue } from "@shorok/shared";
// `Prisma` is a runtime namespace (Prisma.Decimal), not just a type.
/* eslint-disable-next-line @typescript-eslint/consistent-type-imports */
import { Prisma } from "../../prisma/prisma.service";

/** Shared vocabulary for both revision services. */

export const D = (v: Prisma.Decimal | Decimal | string | number | null | undefined): Decimal =>
  new Decimal((v ?? 0).toString());

export function issue(code: string, messageAr: string, context?: Record<string, string | number | null>): RevisionIssue {
  return { code, messageAr, ...(context ? { context } : {}) };
}

/** Stock ledger used while projecting a revision, keyed branch|variant. */
export class StockProjection {
  private readonly boards = new Map<string, Decimal>();
  private readonly meters = new Map<string, Decimal>();

  static key(branchId: string, variantId: string): string {
    return `${branchId}|${variantId}`;
  }

  seed(branchId: string, variantId: string, boards: Decimal, meters: Decimal): void {
    const k = StockProjection.key(branchId, variantId);
    this.boards.set(k, boards);
    this.meters.set(k, meters);
  }

  apply(branchId: string, variantId: string, boardsDelta: Decimal, metersDelta: Decimal): void {
    const k = StockProjection.key(branchId, variantId);
    this.boards.set(k, (this.boards.get(k) ?? new Decimal(0)).plus(boardsDelta));
    this.meters.set(k, (this.meters.get(k) ?? new Decimal(0)).plus(metersDelta));
  }

  get(branchId: string, variantId: string): { boards: Decimal; meters: Decimal } {
    const k = StockProjection.key(branchId, variantId);
    return {
      boards: this.boards.get(k) ?? new Decimal(0),
      meters: this.meters.get(k) ?? new Decimal(0),
    };
  }

  /** Every pair that ends up below zero on either measure. */
  negatives(): Array<{ branchId: string; productVariantId: string; boards: string; meters: string }> {
    const out: Array<{ branchId: string; productVariantId: string; boards: string; meters: string }> = [];
    for (const [k, boards] of this.boards) {
      const meters = this.meters.get(k) ?? new Decimal(0);
      if (boards.isNegative() || meters.isNegative()) {
        const [branchId, productVariantId] = k.split("|");
        out.push({
          branchId: branchId!,
          productVariantId: productVariantId!,
          boards: boards.toFixed(4),
          meters: meters.toFixed(4),
        });
      }
    }
    return out;
  }
}

/**
 * The pooled-average rule this codebase already applies whenever stock moves
 * with a known value (see the two return services): the pool absorbs the value,
 * then the rate is re-derived from it. Never a blind overwrite of the rate.
 */
export function repriceGlobalPool(input: {
  currentMeters: Decimal;
  currentBoards: Decimal;
  currentWacPerMeter: Decimal;
  metersDelta: Decimal;
  boardsDelta: Decimal;
  valueDelta: Decimal;
}): { meters: Decimal; boards: Decimal; value: Decimal; wacPerMeter: Decimal; wacPerBoard: Decimal } {
  const meters = input.currentMeters.plus(input.metersDelta);
  const boards = input.currentBoards.plus(input.boardsDelta);
  const value = input.currentMeters.times(input.currentWacPerMeter).plus(input.valueDelta);
  return {
    meters,
    boards,
    value,
    wacPerMeter: meters.gt(0) ? value.div(meters) : new Decimal(0),
    wacPerBoard: boards.gt(0) ? value.div(boards) : new Decimal(0),
  };
}

/** Money formatting used everywhere a Decimal crosses the API boundary. */
export const money = (v: Decimal): string => v.toFixed(2);
export const qty = (v: Decimal): string => v.toFixed(4);
export const rate = (v: Decimal): string => v.toFixed(4);
