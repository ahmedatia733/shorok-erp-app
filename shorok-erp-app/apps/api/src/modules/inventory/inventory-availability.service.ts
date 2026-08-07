import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { PrismaService } from "../../prisma/prisma.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import {
  decideSourceAvailability,
  tryClassifyTransferSizeOption,
  type SourceAvailabilityVerdict,
  type TransferSizeDisplay,
} from "../inventory-transfers/size-classification";

const D = (v: unknown): Decimal => new Decimal((v ?? 0).toString());

/** One product that has at least one usable size in a branch. */
export interface BranchProduct {
  productSkuId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  /** How many of its sizes are usable in this branch. */
  availableSizeCount: number;
}

/** One exact size of one product, as it stands in one branch. */
export interface BranchSize {
  productVariantId: string;
  display: TransferSizeDisplay;
  boardsOnHand: Decimal;
  metersOnHand: Decimal;
  verdict: SourceAvailabilityVerdict;
}

/**
 * What a branch actually holds, asked once and answered the same way for
 * everyone.
 *
 * Two screens need this question answered: a transfer picking stock to send,
 * and a stock adjustment picking stock to correct. They must not disagree —
 * if they did, one screen would offer a product the other insists has nothing,
 * and a storekeeper would be left deciding which to believe. So the query and
 * the availability rule live here, and the callers only choose how to present
 * the answer.
 *
 * Read-only by construction: this service holds no write method.
 */
@Injectable()
export class InventoryAvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every product with at least one usable size in this branch.
   *
   * One query. Balances are attached to the variants by a filtered relation, so
   * the cost does not grow with the catalogue — asking the size endpoint once
   * per product would put one request per product on a live server every time
   * a dropdown opened.
   */
  async productsInBranch(branchId: string): Promise<BranchProduct[]> {
    const variants = await this.prisma.productVariant.findMany({
      where: { sku: { active: true } },
      select: {
        id: true,
        sizeMetersPerBoard: true,
        active: true,
        sku: { select: { id: true, code: true, colorNameAr: true, colorNameEn: true } },
        inventoryBalances: {
          where: { branchId },
          select: { boardsOnHand: true, metersOnHand: true },
        },
      },
    });

    const bySku = new Map<string, BranchProduct>();
    for (const variant of variants) {
      // A size that cannot be classified cannot be offered, so it cannot make
      // its product selectable either.
      if (!tryClassifyTransferSizeOption({ sizeMetersPerBoard: variant.sizeMetersPerBoard })) continue;

      const balance = variant.inventoryBalances[0];
      const { enabled } = decideSourceAvailability({
        variantActive: variant.active,
        boards: D(balance?.boardsOnHand),
        metres: D(balance?.metersOnHand),
      });
      if (!enabled) continue;

      const existing = bySku.get(variant.sku.id);
      if (existing) {
        existing.availableSizeCount += 1;
        continue;
      }
      bySku.set(variant.sku.id, {
        productSkuId: variant.sku.id,
        code: variant.sku.code,
        nameAr: variant.sku.colorNameAr,
        nameEn: variant.sku.colorNameEn ?? null,
        availableSizeCount: 1,
      });
    }

    return [...bySku.values()].sort((a, b) => a.code.localeCompare(b.code, "ar", { numeric: true }));
  }

  /**
   * Every size of one product, with what this branch holds of each.
   *
   * Built from the product's variants rather than from balance rows, so a size
   * the product has but this branch does not can still be shown and disabled —
   * "not here" is information; a silently missing card just looks like a bug.
   */
  async sizesInBranch(branchId: string, productSkuId: string): Promise<BranchSize[]> {
    const variants = await this.prisma.productVariant.findMany({
      where: { skuId: productSkuId },
      select: {
        id: true,
        sizeMetersPerBoard: true,
        active: true,
        inventoryBalances: {
          where: { branchId },
          select: { boardsOnHand: true, metersOnHand: true },
        },
      },
    });

    const sizes: BranchSize[] = [];
    for (const variant of variants) {
      const display = tryClassifyTransferSizeOption({ sizeMetersPerBoard: variant.sizeMetersPerBoard });
      if (!display) continue;

      const balance = variant.inventoryBalances[0];
      const boards = D(balance?.boardsOnHand);
      const metres = D(balance?.metersOnHand);

      sizes.push({
        productVariantId: variant.id,
        display,
        boardsOnHand: boards,
        metersOnHand: metres,
        verdict: decideSourceAvailability({ variantActive: variant.active, boards, metres }),
      });
    }

    // ك first, then ص, then the custom sizes ascending — the order a
    // storekeeper expects to scan, not database order.
    const rank: Record<string, number> = { LARGE: 0, SMALL: 1, CUSTOM: 2 };
    return sizes.sort((a, b) => {
      const byBadge = (rank[a.display.badge] ?? 9) - (rank[b.display.badge] ?? 9);
      if (byBadge !== 0) return byBadge;
      return new Decimal(a.display.boardSizeMeters).comparedTo(new Decimal(b.display.boardSizeMeters));
    });
  }
}
