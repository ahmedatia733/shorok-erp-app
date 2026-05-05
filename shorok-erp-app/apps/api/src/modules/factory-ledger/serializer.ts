import type { FactoryLedgerEntry } from "@prisma/client";

/**
 * One serializer for both write responses and list rows so callers see a
 * stable shape with stringified Decimals (network/JSON-safe).
 */
export function serializeEntry(row: FactoryLedgerEntry) {
  return {
    id: row.id,
    supplierId: row.supplierId,
    orderDate: row.orderDate,
    productVariantId: row.productVariantId,
    boardsQuantity: row.boardsQuantity?.toString() ?? null,
    metersQuantity: row.metersQuantity?.toString() ?? null,
    purchasePricePerMeter: row.purchasePricePerMeter?.toString() ?? null,
    totalAmount: row.totalAmount.toString(),
    paidAmount: row.paidAmount.toString(),
    runningBalance: row.runningBalance.toString(),
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}
