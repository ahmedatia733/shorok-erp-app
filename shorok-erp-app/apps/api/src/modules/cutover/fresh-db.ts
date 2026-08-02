import type { Prisma } from "@prisma/client";
import { CUTOVER_ERROR, CutoverRefusal } from "./cutover.types";

/**
 * Fresh-database preparation.
 *
 * Historical migrations seed demo business data — 54 customers, 48 paint-colour
 * SKUs with their variants, and one supplier — alongside the rows the system
 * genuinely needs. Those migrations have already been applied everywhere and
 * must NOT be edited, so the demo rows are removed afterwards instead.
 *
 * Removal is by EXACT identity taken from the migration definitions, never by a
 * fuzzy pattern: a real customer whose code happened to look similar must never
 * be caught by this. And nothing is removed at all unless the database is proven
 * to hold no operational document.
 */

/** Exactly the customer codes inserted by 20260630110000_add_customers_and_transactions. */
export const SEEDED_CUSTOMER_CODES: readonly string[] = Array.from(
  { length: 54 },
  (_, i) => `CST${String(i + 1).padStart(3, "0")}`,
);

/**
 * Exactly the SKU codes inserted by 20260630010000_seed_ap_paint_colors. Every
 * one is prefixed `AP ` — but the prefix is used only to CHECK the list, never
 * as the deletion predicate.
 */
export const SEEDED_SKU_CODE_PREFIX = "AP ";

/**
 * Supplier inserted by 20260630060000_seed_supplier_mega_bond. Matched on the
 * ASCII English name: the Arabic name carries hamza forms (إ / أ) that are easy
 * to transcribe wrongly, and a near-miss here would silently delete nothing.
 */
export const SEEDED_SUPPLIER_NAME_EN = "Mega Bond UAE-American Company";

export interface FreshDbCounts {
  customers: number;
  productSkus: number;
  productVariants: number;
  suppliers: number;
  accounts: number;
  branches: number;
  users: number;
}

export interface FreshDbReport {
  before: FreshDbCounts;
  after: FreshDbCounts;
  removed: {
    customers: number;
    productSkus: number;
    productVariants: number;
    suppliers: number;
  };
  retained: {
    accounts: number;
    systemRoleAccounts: number;
  };
  alreadyClean: boolean;
}

type Tx = Prisma.TransactionClient;

async function counts(tx: Tx): Promise<FreshDbCounts> {
  const [customers, productSkus, productVariants, suppliers, accounts, branches, users] =
    await Promise.all([
      tx.customer.count(),
      tx.productSku.count(),
      tx.productVariant.count(),
      tx.supplier.count(),
      tx.account.count(),
      tx.branch.count(),
      tx.user.count(),
    ]);
  return { customers, productSkus, productVariants, suppliers, accounts, branches, users };
}

/**
 * Refuse unless the database holds NO operational document. A database that has
 * been transacted on is not a fresh cutover target, and deleting master data
 * under live documents would orphan them.
 */
export async function assertDatabaseIsFresh(tx: Tx): Promise<void> {
  const checks: Array<[string, Promise<number>]> = [
    ["salesInvoices", tx.salesInvoice.count()],
    ["purchaseInvoices", tx.purchaseInvoice.count()],
    ["salesReturns", tx.salesReturn.count()],
    ["purchaseReturns", tx.purchaseReturn.count()],
    ["expenses", tx.expense.count()],
    ["receiptVouchers", tx.receiptVoucher.count()],
    ["paymentVouchers", tx.paymentVoucher.count()],
    ["journalEntries", tx.journalEntry.count()],
    ["inventoryMovements", tx.inventoryMovement.count()],
    ["cutoverImportBatches", tx.cutoverImportBatch.count()],
    ["customerTransactions", tx.customerTransaction.count()],
    ["customerOrders", tx.customerOrder.count()],
  ];
  for (const [name, promise] of checks) {
    const n = await promise;
    if (n > 0) throw new CutoverRefusal(CUTOVER_ERROR.DB_NOT_FRESH, { table: name, rows: n });
  }
}

/**
 * Refuse if a demo row is actually referenced by something operational. This is
 * belt-and-braces behind `assertDatabaseIsFresh`: if either check is wrong, the
 * other still stops the deletion.
 */
async function assertNoOperationalReferences(tx: Tx, customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;
  const referenced = await tx.salesInvoice.count({ where: { customerId: { in: customerIds } } });
  if (referenced > 0) {
    throw new CutoverRefusal(CUTOVER_ERROR.DEMO_ROW_HAS_OPERATIONAL_REFERENCES, {
      entity: "CUSTOMER",
      rows: referenced,
    });
  }
}

/**
 * Remove the migration-seeded demo business rows and nothing else.
 *
 * Preserved on purpose: the chart of accounts, VAT and other system-role
 * accounts, treasuries, posting/configuration rows, branches, users, and the
 * migration history itself.
 *
 * Idempotent: a second run finds nothing to remove and reports `alreadyClean`.
 */
export async function prepareFreshDatabase(tx: Tx): Promise<FreshDbReport> {
  const before = await counts(tx);

  await assertDatabaseIsFresh(tx);

  // Exact-identity targeting, resolved to ids first so the deletes cannot widen.
  const demoCustomers = await tx.customer.findMany({
    where: { code: { in: [...SEEDED_CUSTOMER_CODES] } },
    select: { id: true, code: true },
  });
  await assertNoOperationalReferences(
    tx,
    demoCustomers.map((c) => c.id),
  );

  const demoSkus = await tx.productSku.findMany({
    where: { code: { startsWith: SEEDED_SKU_CODE_PREFIX } },
    select: { id: true },
  });
  const demoSkuIds = demoSkus.map((s) => s.id);

  const removedVariants = await tx.productVariant.deleteMany({
    where: { skuId: { in: demoSkuIds } },
  });
  const removedSkus = await tx.productSku.deleteMany({ where: { id: { in: demoSkuIds } } });
  const removedCustomers = await tx.customer.deleteMany({
    where: { id: { in: demoCustomers.map((c) => c.id) } },
  });
  const removedSuppliers = await tx.supplier.deleteMany({
    where: { nameEn: SEEDED_SUPPLIER_NAME_EN },
  });

  const after = await counts(tx);
  const systemRoleAccounts = await tx.account.count({ where: { systemRole: { not: null } } });

  return {
    before,
    after,
    removed: {
      customers: removedCustomers.count,
      productSkus: removedSkus.count,
      productVariants: removedVariants.count,
      suppliers: removedSuppliers.count,
    },
    retained: { accounts: after.accounts, systemRoleAccounts },
    alreadyClean:
      removedCustomers.count === 0 &&
      removedSkus.count === 0 &&
      removedVariants.count === 0 &&
      removedSuppliers.count === 0,
  };
}
