import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
// Value imports, NOT `import type`: Nest reads these classes from the emitted
// decorator metadata to resolve the constructor, and a type-only import is
// erased at compile time — the code would compile and then fail to inject.
// The rule is disabled here so `eslint --fix` cannot silently reintroduce it.
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Prisma, PrismaService } from "../../prisma/prisma.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import {
  compareTimelines,
  type ReplayComparison,
  type ValuationEvent,
} from "./valuation-replay";

type Tx = Prisma.TransactionClient;

/** One revised receipt the caller wants substituted into the timeline. */
export interface ReceiptSubstitution {
  productVariantId: string;
  meters: Decimal;
  /** Ex-tax value entering inventory. */
  value: Decimal;
}

export interface VariantReplay {
  productVariantId: string;
  presentMeters: Decimal;
  presentWacPerMeter: Decimal;
  comparison: ReplayComparison;
  eventCount: number;
  replayStartAt: Date | null;
}

/**
 * Builds the valuation timeline for the variants a purchase revision touches
 * and hands it to the pure replay.
 *
 * Classification is deliberately derived from what the running system actually
 * does to `avg_cost_per_meter`, not from what a movement type sounds like. Only
 * four code paths ever rewrite it — purchase confirm, sales return, purchase
 * return and the cutover import. Every other movement (counts, adjustments,
 * cancels, sales) leaves the rate alone, which under a pooled average means it
 * moves value by quantity × the prevailing rate. Modelling them as anything
 * else would make the replay disagree with the database it is meant to explain.
 */
@Injectable()
export class ValuationReplayService {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx) {
    return tx ?? this.prisma;
  }

  /**
   * @param purchaseInvoiceId the invoice being revised — its own receipts are
   *        the events that get substituted
   * @param substitutions     the revised receipts, per variant
   * @param presentOverride   optional (variantId → metres) on-hand to use
   *        instead of reading it, so a caller inside the write transaction can
   *        replay against the state as it was BEFORE it moved any stock
   */
  async forPurchaseRevision(input: {
    purchaseInvoiceId: string;
    substitutions: ReceiptSubstitution[];
    tx?: Tx;
    presentMeters?: Map<string, Decimal>;
    presentWac?: Map<string, Decimal>;
  }): Promise<VariantReplay[]> {
    const db = this.db(input.tx);

    const originalLines = await db.purchaseInvoiceLine.findMany({
      where: { invoiceId: input.purchaseInvoiceId },
      select: { productVariantId: true, metersQuantity: true, lineTotal: true },
    });

    const variantIds = [
      ...new Set([
        ...originalLines.map((l) => l.productVariantId),
        ...input.substitutions.map((s) => s.productVariantId),
      ]),
    ].sort();
    if (variantIds.length === 0) return [];

    // Replay window: from this invoice's own earliest receipt onwards. Anything
    // before it is untouched by the revision and is folded into the anchor.
    const firstReceipt = await db.inventoryMovement.findFirst({
      where: { referenceType: "purchase_invoice", referenceId: input.purchaseInvoiceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { createdAt: true },
    });
    const replayStartAt = firstReceipt?.createdAt ?? null;

    const movements = await db.inventoryMovement.findMany({
      where: {
        productVariantId: { in: variantIds },
        ...(replayStartAt ? { createdAt: { gte: replayStartAt } } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        productVariantId: true,
        movementType: true,
        metersQuantity: true,
        referenceType: true,
        referenceId: true,
        createdAt: true,
      },
    });

    const rates = await this.valueRates(db, movements);

    const variants = await db.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, avgCostPerMeter: true },
    });
    const wacById = new Map(variants.map((v) => [v.id, new Decimal(v.avgCostPerMeter.toString())]));

    const balances = await db.branchInventoryBalance.groupBy({
      by: ["productVariantId"],
      where: { productVariantId: { in: variantIds } },
      _sum: { metersOnHand: true },
    });
    const metersById = new Map(
      balances.map((b) => [b.productVariantId, new Decimal(b._sum.metersOnHand?.toString() ?? "0")]),
    );

    const subByVariant = new Map(input.substitutions.map((s) => [s.productVariantId, s]));

    const out: VariantReplay[] = [];
    for (const variantId of variantIds) {
      const own = movements.filter((m) => m.productVariantId === variantId);
      const currentEvents: ValuationEvent[] = own.map((m) => this.classify(m, rates));

      // Substitute in place: drop this invoice's own receipts for the variant
      // and insert the revised one at the same point in the timeline.
      const anchorAt =
        own.find((m) => m.referenceType === "purchase_invoice" && m.referenceId === input.purchaseInvoiceId)
          ?.createdAt ?? replayStartAt;
      const revisedEvents: ValuationEvent[] = currentEvents.filter(
        (e) => !e.id.startsWith("mv:") || !this.isOwnReceipt(own, e.id, input.purchaseInvoiceId),
      );
      const sub = subByVariant.get(variantId);
      if (sub && sub.meters.gt(0) && anchorAt) {
        revisedEvents.push({
          id: `0000revised:${variantId}`,
          at: anchorAt,
          kind: "RECEIPT",
          meters: sub.meters,
          value: sub.value,
          recordedIssueRate: null,
          sourceRef: `purchase_invoice_revision:${input.purchaseInvoiceId}`,
        });
      }

      const presentMeters =
        input.presentMeters?.get(variantId) ?? metersById.get(variantId) ?? new Decimal(0);
      const presentWac = input.presentWac?.get(variantId) ?? wacById.get(variantId) ?? new Decimal(0);

      out.push({
        productVariantId: variantId,
        presentMeters,
        presentWacPerMeter: presentWac,
        eventCount: currentEvents.length,
        replayStartAt,
        comparison: compareTimelines({
          presentMeters,
          presentWacPerMeter: presentWac,
          currentEvents,
          revisedEvents,
        }),
      });
    }
    return out;
  }

  private isOwnReceipt(
    own: Array<{ id: string; referenceType: string | null; referenceId: string | null }>,
    eventId: string,
    invoiceId: string,
  ): boolean {
    const movementId = eventId.slice(3);
    const m = own.find((x) => x.id === movementId);
    return m?.referenceType === "purchase_invoice" && m?.referenceId === invoiceId;
  }

  /**
   * Per-metre value rates for every movement whose source document records one.
   * Keyed `<referenceType>:<referenceId>:<variantId>`. When several lines of one
   * document share a variant the rate is their weighted average, which is exact
   * for the single-line case and correct in aggregate otherwise.
   */
  private async valueRates(
    db: Tx | PrismaService,
    movements: Array<{ referenceType: string | null; referenceId: string | null; productVariantId: string }>,
  ): Promise<Map<string, { rate: Decimal; recorded: Decimal | null }>> {
    const rates = new Map<string, { rate: Decimal; recorded: Decimal | null }>();
    const idsFor = (type: string) => [
      ...new Set(
        movements.filter((m) => m.referenceType === type && m.referenceId).map((m) => m.referenceId!),
      ),
    ];

    const purchaseIds = idsFor("purchase_invoice");
    if (purchaseIds.length) {
      const lines = await db.purchaseInvoiceLine.findMany({
        where: { invoiceId: { in: purchaseIds } },
        select: { invoiceId: true, productVariantId: true, metersQuantity: true, lineTotal: true },
      });
      accumulate(rates, lines, "purchase_invoice", (l) => l.invoiceId, (l) => l.metersQuantity, (l) => l.lineTotal);
    }

    const salesIds = idsFor("sales_invoice");
    if (salesIds.length) {
      const lines = await db.salesInvoiceLine.findMany({
        where: { invoiceId: { in: salesIds } },
        select: {
          invoiceId: true,
          productVariantId: true,
          metersQuantity: true,
          quantity: true,
          lineCogsAtPosting: true,
        },
      });
      accumulate(
        rates,
        lines,
        "sales_invoice",
        (l) => l.invoiceId,
        (l) => l.metersQuantity ?? l.quantity,
        (l) => l.lineCogsAtPosting ?? new Prisma.Decimal(0),
      );
    }

    const salesReturnIds = [...idsFor("sales_return"), ...idsFor("sales_return_cancel")];
    if (salesReturnIds.length) {
      const lines = await db.salesReturnLine.findMany({
        where: { salesReturnId: { in: salesReturnIds } },
        select: {
          salesReturnId: true,
          productVariantId: true,
          returnedMetersQuantity: true,
          returnCogs: true,
        },
      });
      for (const type of ["sales_return", "sales_return_cancel"]) {
        accumulate(rates, lines, type, (l) => l.salesReturnId, (l) => l.returnedMetersQuantity, (l) => l.returnCogs);
      }
    }

    const purchaseReturnIds = [...idsFor("purchase_return"), ...idsFor("purchase_return_cancel")];
    if (purchaseReturnIds.length) {
      const lines = await db.purchaseReturnLine.findMany({
        where: { purchaseReturnId: { in: purchaseReturnIds } },
        select: {
          purchaseReturnId: true,
          productVariantId: true,
          returnedMetersQuantity: true,
          inventoryValueOut: true,
        },
      });
      for (const type of ["purchase_return", "purchase_return_cancel"]) {
        accumulate(
          rates,
          lines,
          type,
          (l) => l.purchaseReturnId,
          (l) => l.returnedMetersQuantity,
          (l) => l.inventoryValueOut,
        );
      }
    }

    return rates;
  }

  private classify(
    m: {
      id: string;
      movementType: string;
      metersQuantity: Prisma.Decimal;
      referenceType: string | null;
      referenceId: string | null;
      productVariantId: string;
      createdAt: Date;
    },
    rates: Map<string, { rate: Decimal; recorded: Decimal | null }>,
  ): ValuationEvent {
    const meters = new Decimal(m.metersQuantity.toString());
    const key = `${m.referenceType}:${m.referenceId}:${m.productVariantId}`;
    const entry = rates.get(key);
    const base = {
      id: `mv:${m.id}`,
      at: m.createdAt,
      meters,
      sourceRef: m.referenceType ? `${m.referenceType}:${m.referenceId}` : null,
    };

    // Value-bearing paths — the four that genuinely rewrite avg_cost_per_meter.
    if (m.movementType === "RECEIPT" && m.referenceType === "purchase_invoice" && entry) {
      return { ...base, kind: "RECEIPT", value: meters.abs().times(entry.rate), recordedIssueRate: null };
    }
    if (m.movementType === "SALE_RETURN" && entry) {
      const kind = meters.isPositive() ? "VALUE_IN" : "VALUE_OUT";
      return { ...base, kind, value: meters.abs().times(entry.rate), recordedIssueRate: null };
    }
    if (m.movementType === "PURCHASE_RETURN" && entry) {
      const kind = meters.isNegative() ? "VALUE_OUT" : "VALUE_IN";
      return { ...base, kind, value: meters.abs().times(entry.rate), recordedIssueRate: null };
    }
    // A sale issues at the prevailing pooled rate and leaves it unchanged; the
    // cost it actually posted is carried along only so the replay can be
    // checked against recorded history.
    if (m.movementType === "SALE") {
      return { ...base, kind: "ISSUE", value: null, recordedIssueRate: entry?.rate ?? null };
    }
    // Counts, adjustments and every cancel compensation: quantity only. No code
    // path revalues on these, so the rate carries through untouched.
    return { ...base, kind: "QUANTITY_ONLY", value: null, recordedIssueRate: null };
  }
}

function accumulate<T>(
  rates: Map<string, { rate: Decimal; recorded: Decimal | null }>,
  lines: T[],
  refType: string,
  refId: (l: T) => string,
  meters: (l: T) => Prisma.Decimal | Decimal,
  value: (l: T) => Prisma.Decimal | Decimal,
): void {
  const sums = new Map<string, { m: Decimal; v: Decimal }>();
  for (const l of lines) {
    const variantId = (l as unknown as { productVariantId: string }).productVariantId;
    const key = `${refType}:${refId(l)}:${variantId}`;
    const cur = sums.get(key) ?? { m: new Decimal(0), v: new Decimal(0) };
    cur.m = cur.m.plus(new Decimal(meters(l).toString()));
    cur.v = cur.v.plus(new Decimal(value(l).toString()));
    sums.set(key, cur);
  }
  for (const [key, { m, v }] of sums) {
    const rate = m.gt(0) ? v.div(m) : new Decimal(0);
    rates.set(key, { rate, recorded: rate });
  }
}
