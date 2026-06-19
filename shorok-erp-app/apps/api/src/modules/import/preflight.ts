import { PrismaClient } from "@prisma/client";

export interface PreflightItem {
  code: string;
  size: number;
}

export interface PreflightResult {
  valid: boolean;
  missingSkus: string[];
  missingVariants: { code: string; size: number }[];
}

export class ImportPreflight {
  static async validate(
    prisma: PrismaClient,
    items: PreflightItem[]
  ): Promise<PreflightResult> {
    const missingSkus: string[] = [];
    const missingVariants: { code: string; size: number }[] = [];

    // Deduplicate items to avoid redundant queries
    const uniqueItemsMap = new Map<string, PreflightItem>();
    for (const item of items) {
      uniqueItemsMap.set(`${item.code}-${item.size.toFixed(4)}`, item);
    }
    const uniqueItems = Array.from(uniqueItemsMap.values());

    for (const item of uniqueItems) {
      const sku = await prisma.productSku.findUnique({
        where: { code: item.code },
        include: { variants: true },
      });

      if (!sku) {
        if (!missingSkus.includes(item.code)) {
          missingSkus.push(item.code);
        }
        missingVariants.push(item);
      } else {
        const hasVariant = sku.variants.some((v) => {
          const vSize = parseFloat(v.sizeMetersPerBoard.toString());
          return Math.abs(vSize - item.size) < 0.01;
        });

        if (!hasVariant) {
          missingVariants.push(item);
        }
      }
    }

    return {
      valid: missingSkus.length === 0 && missingVariants.length === 0,
      missingSkus,
      missingVariants,
    };
  }
}
