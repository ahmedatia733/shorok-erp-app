import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import { ValidationError } from "../../common/errors/api-errors";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { InventoryEngine } from "../inventory/inventory.engine";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import type { AuthenticatedUser } from "../../common/types/request-user";

type Tx = Prisma.TransactionClient;

const D = (v: unknown): Decimal => new Decimal((v ?? 0).toString());

export interface ReturnStockLine {
  variantId: string;
  meters: Decimal;
  boards: Decimal;
  /** The value the goods carry back into stock. Always an explicit amount. */
  cogs: Decimal;
}

export interface ReturnStockRefs {
  /** Movement reference on the way in, e.g. "sales_return". */
  applyRefType: string;
  /** Movement reference on the way back out, e.g. "sales_return_cancel". */
  reverseRefType: string;
  refId: string;
  summaryApplyAr: string;
  summaryReverseAr: string;
  summaryApplyEn: string;
  summaryReverseEn: string;
  humanReadableNote: string;
}

/**
 * Putting returned goods back into stock, and moving the weighted-average cost
 * with them.
 *
 * This is the single costing path for every kind of return. It was extracted
 * from the invoice-linked sales return unchanged so that «مردودات بدون فواتير»
 * could reuse it rather than grow a second weighted-average implementation —
 * two of those would eventually disagree, and the one that disagreed would be
 * the one nobody was testing.
 *
 * What differs between the two documents is only the VALUE each hands over:
 *
 *   - an invoice-linked return carries the historical cost snapshotted on the
 *     original invoice line, which is what it originally left stock at;
 *   - a legacy return has no such invoice, so by the approved policy it carries
 *     the variant's current weighted-average cost, snapshotted at confirmation.
 *
 * The arithmetic below is identical either way: value and quantity move
 * together, and the new average falls out of them. That is also why the legacy
 * policy leaves the average undisturbed — goods coming in *at* the current
 * average cannot move it.
 *
 * Variants are locked in a deterministic order: this is the costing lock, and
 * taking it in sorted order is what stops two concurrent returns deadlocking or
 * losing an update.
 */
@Injectable()
export class ReturnStockService {
  constructor(private readonly inventoryEngine: InventoryEngine) {}

  /**
   * `sign = 1` puts the goods in; `sign = -1` takes back out exactly what was
   * put in. A reversal is refused rather than allowed to drive stock or its
   * value negative — if the returned goods have since been sold or transferred,
   * the cancellation cannot pretend otherwise.
   */
  async apply(
    tx: Tx,
    lines: ReturnStockLine[],
    branchId: string,
    user: AuthenticatedUser,
    sign: 1 | -1,
    refs: ReturnStockRefs,
  ): Promise<void> {
    const groups = new Map<string, { meters: Decimal; boards: Decimal; cogs: Decimal; items: ReturnStockLine[] }>();
    for (const l of lines) {
      const g = groups.get(l.variantId) ?? { meters: new Decimal(0), boards: new Decimal(0), cogs: new Decimal(0), items: [] };
      g.meters = g.meters.plus(l.meters);
      g.boards = g.boards.plus(l.boards);
      g.cogs = g.cogs.plus(l.cogs);
      g.items.push(l);
      groups.set(l.variantId, g);
    }

    const variantIds = [...groups.keys()].sort();
    for (const vid of variantIds) {
      await tx.$queryRaw`SELECT id FROM product_variants WHERE id = ${vid}::uuid FOR UPDATE`;
    }

    for (const vid of variantIds) {
      const g = groups.get(vid)!;
      const agg = await tx.branchInventoryBalance.aggregate({
        _sum: { metersOnHand: true, boardsOnHand: true },
        where: { productVariantId: vid },
      });
      const curMeters = D(agg._sum.metersOnHand);
      const curBoards = D(agg._sum.boardsOnHand);
      const variant = await tx.productVariant.findUnique({
        where: { id: vid },
        select: { avgCostPerMeter: true },
      });
      const curValue = curMeters.mul(D(variant?.avgCostPerMeter));
      const newMeters = curMeters.plus(g.meters.mul(sign));
      const newBoards = curBoards.plus(g.boards.mul(sign));
      const newValue = curValue.plus(g.cogs.mul(sign));

      if (newMeters.isNegative() || newBoards.isNegative() || newValue.isNegative()) {
        throw new ValidationError({
          reason: "return_reversal_would_make_stock_negative",
          productVariantId: vid,
          messageAr: "لا يمكن إلغاء المرتجع: البضاعة المرتجعة استُهلكت ولا يوجد رصيد كافٍ لعكسها.",
        });
      }

      await tx.productVariant.update({
        where: { id: vid },
        data: {
          avgCostPerMeter: newMeters.gt(0) ? newValue.div(newMeters).toFixed(4) : "0",
          avgCost: newBoards.gt(0) ? newValue.div(newBoards).toFixed(4) : "0",
          costUpdatedAt: new Date(),
        },
      });

      for (const it of g.items) {
        await this.inventoryEngine.apply({
          branchId,
          productVariantId: vid,
          movementType: "SALE_RETURN",
          boardsDelta: it.boards.mul(sign).toFixed(4),
          metersDelta: it.meters.mul(sign).toFixed(4),
          reference: { type: sign > 0 ? refs.applyRefType : refs.reverseRefType, id: refs.refId },
          actor: user,
          summaryAr: sign > 0 ? refs.summaryApplyAr : refs.summaryReverseAr,
          summaryEn: sign > 0 ? refs.summaryApplyEn : refs.summaryReverseEn,
          humanReadableNote: refs.humanReadableNote,
          tx,
        });
      }
    }
  }
}
