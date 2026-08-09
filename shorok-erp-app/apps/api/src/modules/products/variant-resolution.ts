import { Prisma } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";

/**
 * Turning "this product, at this size" into the exact ProductVariant.
 *
 * A catalogue product is allowed to exist with no sizes at all — that is simply
 * a product nobody has bought yet. Buying is where its first real size arrives,
 * so a purchase line may name the base ProductSku and the size actually
 * purchased, and this resolves it: the exact variant if it already exists, a new
 * one if it does not.
 *
 * Two rules matter more than convenience:
 *
 *   - A size is never invented. Nothing here creates a placeholder, a default
 *     4 m or 5.25 m, or a zero — a variant appears only once a real purchased
 *     size has been supplied by the person entering the invoice.
 *   - A retired size is never quietly revived. If the size exists but was
 *     deactivated, that was somebody's decision, and resurrecting it would also
 *     put it back in front of the sales picker. The purchase is refused with a
 *     typed error instead.
 *
 * `@@unique([skuId, sizeMetersPerBoard])` is what makes this safe under
 * concurrency: two people adding the same first size race, the index picks a
 * winner, and the loser re-reads the winner's row rather than failing.
 */

/** The subset of Prisma the resolver needs — satisfied by the client and by a tx. */
type VariantWriter = Pick<Prisma.TransactionClient, "productSku" | "productVariant">;

export interface VariantResolutionInput {
  productVariantId?: string;
  productSkuId?: string;
  sizeMetersPerBoard?: string;
}

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/**
 * Resolves one purchase line to the exact ProductVariant it buys.
 *
 * Returns the variant id and whether this call brought the variant into
 * existence, so the caller can report first-size creation honestly.
 */
export async function resolvePurchaseVariant(
  tx: VariantWriter,
  line: VariantResolutionInput,
): Promise<{ productVariantId: string; created: boolean }> {
  // The explicit form: an exact variant was named. Unchanged behaviour.
  if (line.productVariantId) {
    const variant = await tx.productVariant.findUnique({
      where: { id: line.productVariantId },
      select: { id: true, active: true },
    });
    if (!variant || !variant.active) {
      throw new NotFoundError({ productVariantId: line.productVariantId });
    }
    return { productVariantId: variant.id, created: false };
  }

  const skuId = line.productSkuId;
  const size = line.sizeMetersPerBoard;
  if (!skuId || !size) {
    // The schema refuses this shape, so reaching here means a caller bypassed
    // validation rather than that a user typed something odd.
    throw new NotFoundError({ reason: "PRODUCT_LINE_UNRESOLVABLE" });
  }

  const sku = await tx.productSku.findUnique({
    where: { id: skuId },
    select: { id: true, code: true, colorNameAr: true, active: true, initialPurchasePricePerMeter: true },
  });
  if (!sku) throw new NotFoundError({ productSkuId: skuId });
  if (!sku.active) {
    throw new ValidationError({
      reason: "PRODUCT_INACTIVE",
      productSkuId: skuId,
      messageAr: `الصنف «${sku.code}» غير نشط ولا يمكن الشراء عليه.`,
    });
  }

  // Decimal(10,4) is the stored precision, so "5.25" and "5.2500" are the same
  // size and must find the same row rather than creating a second one.
  const stored = new Prisma.Decimal(size);

  const existing = await tx.productVariant.findUnique({
    where: { skuId_sizeMetersPerBoard: { skuId, sizeMetersPerBoard: stored } },
    select: { id: true, active: true },
  });
  if (existing) {
    if (!existing.active) {
      throw new ValidationError({
        reason: "VARIANT_INACTIVE",
        productSkuId: skuId,
        sizeMetersPerBoard: stored.toFixed(4),
        messageAr: `مقاس ${stored.toFixed(2)} م للصنف «${sku.code}» موقوف. أعد تفعيله من إدارة الأصناف قبل الشراء عليه.`,
      });
    }
    return { productVariantId: existing.id, created: false };
  }

  // The product's first sight of this size. Prices start from whatever the
  // catalogue recorded when the product was created; the invoice's own unit
  // price is what actually values this purchase, and the WAC is computed by the
  // existing posting path exactly as before.
  const startingPurchasePrice = sku.initialPurchasePricePerMeter ?? new Prisma.Decimal(0);
  try {
    const created = await tx.productVariant.create({
      data: {
        skuId,
        sizeMetersPerBoard: stored,
        // A sale price is never guessed here — it is entered manually on a sale.
        defaultSalePricePerMeter: new Prisma.Decimal(0),
        defaultPurchasePricePerMeter: startingPurchasePrice,
      },
      select: { id: true },
    });
    return { productVariantId: created.id, created: true };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Someone else created the same first size a moment ago. Their row is the
    // one that exists, so use it.
    const winner = await tx.productVariant.findUnique({
      where: { skuId_sizeMetersPerBoard: { skuId, sizeMetersPerBoard: stored } },
      select: { id: true, active: true },
    });
    if (!winner || !winner.active) {
      throw new ValidationError({
        reason: "VARIANT_INACTIVE",
        productSkuId: skuId,
        sizeMetersPerBoard: stored.toFixed(4),
        messageAr: `تعذّر تجهيز مقاس ${stored.toFixed(2)} م للصنف «${sku.code}».`,
      });
    }
    return { productVariantId: winner.id, created: false };
  }
}
