/**
 * E2E fixture seed for the RETURNS browser tests. Runs ONLY against a local
 * database whose URL contains "test" — it refuses anything else. Truncates the
 * public schema and seeds a deterministic dataset:
 *   - three users: OWNER, ACCOUNTANT, BRANCH_MANAGER (all with branch access)
 *   - 26 confirmed sales invoices + 26 confirmed purchase invoices (so the
 *     OLDEST of each is guaranteed OFF the 20-row first page)
 *   - a pre-made CONFIRMED return on the oldest sale + oldest purchase
 *     (for the deep-link Related-Documents test)
 *   - a legacy-ambiguous sales line (no metres / no dims / zero price)
 *   - a stocked purchase variant for the interactive purchase-return flow
 * The chosen ids + credentials are written to /tmp/shorok-e2e-fixture.json.
 */
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { writeFileSync } from "node:fs";

const url = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(url) || !/test/i.test(url)) {
  throw new Error(`Refusing to seed a non-local / non-test database: ${url.replace(/:[^:@/]*@/, ":***@")}`);
}
const prisma = new PrismaClient();

export const PASSWORD = "E2eOwner@2026";
export const OWNER_PHONE = "+201555000099";
export const ACCOUNTANT_PHONE = "+201555000098";
export const MANAGER_PHONE = "+201555000097";
export const BRANCH_B_PHONE = "+201555000096";

async function main() {
  await prisma.$executeRawUnsafe(`DO $$ DECLARE r RECORD; BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations') LOOP
      EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
    END LOOP; END $$;`);

  const hash = await bcrypt.hash(PASSWORD, 10);
  const owner = await prisma.user.create({ data: { name: "مالك الاختبار", phone: OWNER_PHONE, passwordHash: hash, role: "OWNER", status: "ACTIVE" } });
  const branch = await prisma.branch.create({ data: { nameAr: "فرع الاختبار", nameEn: "Test Branch", active: true } });
  const accountant = await prisma.user.create({ data: { name: "محاسب الاختبار", phone: ACCOUNTANT_PHONE, passwordHash: hash, role: "ACCOUNTANT", status: "ACTIVE" } });
  const manager = await prisma.user.create({ data: { name: "مدير الفرع", phone: MANAGER_PHONE, passwordHash: hash, role: "BRANCH_MANAGER", status: "ACTIVE" } });
  for (const uid of [accountant.id, manager.id]) await prisma.userBranchAccess.create({ data: { userId: uid, branchId: branch.id } });
  // A SECOND branch and a user scoped ONLY to it — used to prove that a deep
  // link to a REAL branch-A invoice leaks nothing to a branch-B user (§4).
  const branchB = await prisma.branch.create({ data: { nameAr: "فرع ب", nameEn: "Branch B", active: true } });
  const branchBUser = await prisma.user.create({ data: { name: "محاسب فرع ب", phone: BRANCH_B_PHONE, passwordHash: hash, role: "ACCOUNTANT", status: "ACTIVE" } });
  await prisma.userBranchAccess.create({ data: { userId: branchBUser.id, branchId: branchB.id } });

  const customer = await prisma.customer.create({ data: { code: "E2E-CUST", nameAr: "عميل الاختبار" } });
  const supplier = await prisma.supplier.create({ data: { nameAr: "مورد الاختبار", nameEn: "Test Supplier" } });
  const rep = await prisma.salesRepresentative.create({ data: { code: "E2E-REP", nameAr: "مندوب الاختبار" } });

  const mk = (code: string, cat: any, t: any, role?: string) =>
    prisma.account.create({ data: { code, nameAr: code, nameEn: code, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } });
  const ar = await mk("E-AR", "ASSET", "CURRENT_ASSET", "AR_CONTROL");
  const ap = await mk("E-AP", "LIABILITY", "LIABILITY", "AP_CONTROL");
  const rev = await mk("E-REV", "REVENUE", "REVENUE");
  const sret = await mk("E-SRET", "REVENUE", "REVENUE");
  const vatO = await mk("E-VATO", "LIABILITY", "LIABILITY");
  const vatI = await mk("E-VATI", "ASSET", "CURRENT_ASSET");
  const cogs = await mk("E-COGS", "COST_OF_SALES", "COST_OF_SALES");
  const inv = await mk("E-INV", "ASSET", "CURRENT_ASSET");
  await prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: ar.id, apAccountId: ap.id, revenueAccountId: rev.id, salesReturnsAccountId: sret.id, vatOutputAccountId: vatO.id, vatInputAccountId: vatI.id, cogsAccountId: cogs.id, inventoryAccountId: inv.id, createdBy: owner.id } });
  for (let m = 1; m <= 12; m++) await prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });

  const skuS = await prisma.productSku.create({ data: { code: "E2E-RED", category: "NORMAL", colorNameAr: "أحمر", colorNameEn: "Red" } });
  const vS = await prisma.productVariant.create({ data: { skuId: skuS.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "500", defaultPurchasePricePerMeter: "300", avgCost: "1200", avgCostPerMeter: "300" } });

  // 26 confirmed sales (dates 2026-01-01 .. 2026-01-26). Oldest is last on a
  // date-desc, 20-row page → OFF the first page.
  const saleIds: string[] = [];
  for (let d = 1; d <= 26; d++) {
    const s = await prisma.salesInvoice.create({ data: {
      invoiceDate: new Date(`2026-01-${String(d).padStart(2, "0")}`), customerId: customer.id, branchId: branch.id, salesRepresentativeId: rep.id,
      status: "CONFIRMED", subtotal: "10000.00", discountAmount: "0", taxRate: "0", taxAmount: "0", grandTotal: "10000.00", totalCost: "6000.00", createdBy: owner.id,
      lines: { create: [{ productVariantId: vS.id, quantity: "5", metersQuantity: "20.0000", unitLabel: "متر", unitPrice: "500.00", costPrice: "0", discountPct: "0", lineTotal: "10000.00", lineCost: "0", unitCostAtPosting: "1200.00", unitCostPerMeterAtPosting: "300.0000", lineCogsAtPosting: "6000.00", taxRateAtPosting: "0" }] },
    } });
    saleIds.push(s.id);
  }
  const oldSaleId = saleIds[0];          // 2026-01-01 — OFF page 1
  const freshSaleOwner = saleIds[25];    // 2026-01-26 — interactive owner flow
  const freshSaleAccountant = saleIds[24];
  const freshSaleManager = saleIds[23];
  const overReturnSaleId = saleIds[22];

  // Pre-made CONFIRMED return on the OLDEST sale (for the deep-link Related
  // Documents test). Created directly — display fixture only.
  const oldSaleLine = (await prisma.salesInvoiceLine.findFirst({ where: { invoiceId: oldSaleId } }))!;
  await prisma.salesReturn.create({ data: {
    originalSalesInvoiceId: oldSaleId, customerId: customer.id, branchId: branch.id, salesRepresentativeId: rep.id,
    returnDate: new Date("2026-01-02"), status: "CONFIRMED", settlementMode: "KEEP_AS_CUSTOMER_CREDIT",
    subtotal: "2000.00", discountTotal: "0", taxTotal: "0", grandTotal: "2000.00", cogsReversalTotal: "1200.00", salesReturnsAccountId: sret.id, confirmedAt: new Date(), confirmedBy: owner.id, createdBy: owner.id,
    lines: { create: [{ originalSalesInvoiceLineId: oldSaleLine.id, productVariantId: vS.id, lengthM: null, widthM: null, returnedBoards: "1.0000", returnedMetersQuantity: "4.0000", originalSalePricePerMeter: "500.00", originalDiscountPct: "0", originalTaxRate: "0", returnSubtotal: "2000.00", returnDiscount: "0", returnNetExTax: "2000.00", returnTax: "0", returnTotal: "2000.00", originalCostPerMeterAtPosting: "300.0000", returnCogs: "1200.00", inventoryDisposition: "RETURN_TO_AVAILABLE_STOCK" }] },
  } });

  // A DRAFT sales return (on freshSaleManager) so the BRANCH_MANAGER can VIEW a
  // draft and we can assert it exposes NO edit/confirm/cancel buttons.
  const mgrLine = (await prisma.salesInvoiceLine.findFirst({ where: { invoiceId: freshSaleManager } }))!;
  const managerDraft = await prisma.salesReturn.create({ data: {
    originalSalesInvoiceId: freshSaleManager, customerId: customer.id, branchId: branch.id, salesRepresentativeId: rep.id,
    returnDate: new Date("2026-01-25"), status: "DRAFT", settlementMode: "KEEP_AS_CUSTOMER_CREDIT",
    subtotal: "2000.00", discountTotal: "0", taxTotal: "0", grandTotal: "2000.00", cogsReversalTotal: "1200.00", createdBy: owner.id,
    lines: { create: [{ originalSalesInvoiceLineId: mgrLine.id, productVariantId: vS.id, returnedBoards: "1.0000", returnedMetersQuantity: "4.0000", originalSalePricePerMeter: "500.00", originalDiscountPct: "0", originalTaxRate: "0", returnSubtotal: "2000.00", returnDiscount: "0", returnNetExTax: "2000.00", returnTax: "0", returnTotal: "2000.00", originalCostPerMeterAtPosting: "300.0000", returnCogs: "1200.00", inventoryDisposition: "RETURN_TO_AVAILABLE_STOCK" }] },
  } });

  // A legacy-AMBIGUOUS sales invoice: no metres, no dims, zero price → the
  // returnable cannot reconstruct metres and blocks the line.
  const legacy = await prisma.salesInvoice.create({ data: {
    invoiceDate: new Date("2025-12-01"), customerId: customer.id, branchId: branch.id, salesRepresentativeId: rep.id,
    status: "CONFIRMED", subtotal: "0", discountAmount: "0", taxRate: "0", taxAmount: "0", grandTotal: "0", totalCost: "0", createdBy: owner.id,
    lines: { create: [{ productVariantId: vS.id, quantity: "5", metersQuantity: null, unitLabel: "وحدة", unitPrice: "0", costPrice: "0", discountPct: "0", lineTotal: "0", lineCost: "0", unitCostAtPosting: "0", taxRateAtPosting: "0" }] },
  } });

  // Purchase variant WITH stock (interactive purchase-return flow) + 26 filler
  // confirmed purchases so the oldest is OFF page 1.
  const skuP = await prisma.productSku.create({ data: { code: "E2E-BLU", category: "NORMAL", colorNameAr: "أزرق", colorNameEn: "Blue" } });
  const vP = await prisma.productVariant.create({ data: { skuId: skuP.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "500", defaultPurchasePricePerMeter: "400", avgCost: "1600", avgCostPerMeter: "400" } });
  await prisma.branchInventoryBalance.create({ data: { branchId: branch.id, productVariantId: vP.id, boardsOnHand: "10.0000", metersOnHand: "40.0000" } });
  const stockedPurchase = await prisma.purchaseInvoice.create({ data: {
    invoiceNumber: "PINV-E2E-STOCK", invoiceDate: new Date("2026-02-15"), supplierId: supplier.id, branchId: branch.id, status: "CONFIRMED",
    subtotal: "16000.00", taxAmount: "0", grandTotal: "16000.00", createdBy: owner.id,
    lines: { create: [{ productVariantId: vP.id, boardsQuantity: "10", metersQuantity: "40.0000", unitPrice: "400.00", lineTotal: "16000.00", taxRate: "0", taxAmount: "0", unitCostAtPosting: "1600.00", taxRateAtPosting: "0" }] },
  } });

  const purchaseIds: string[] = [];
  for (let d = 1; d <= 26; d++) {
    const p = await prisma.purchaseInvoice.create({ data: {
      invoiceNumber: `PINV-E2E-${String(d).padStart(2, "0")}`, invoiceDate: new Date(`2026-01-${String(d).padStart(2, "0")}`), supplierId: supplier.id, branchId: branch.id, status: "CONFIRMED",
      subtotal: "16000.00", taxAmount: "0", grandTotal: "16000.00", createdBy: owner.id,
      lines: { create: [{ productVariantId: vP.id, boardsQuantity: "10", metersQuantity: "40.0000", unitPrice: "400.00", lineTotal: "16000.00", taxRate: "0", taxAmount: "0", unitCostAtPosting: "1600.00", taxRateAtPosting: "0" }] },
    } });
    purchaseIds.push(p.id);
  }
  // A SECOND stocked purchase (own variant + stock) so the ACCOUNTANT purchase
  // flow never contends with the OWNER flow's fixture (§5).
  const skuP2 = await prisma.productSku.create({ data: { code: "E2E-GRN", category: "NORMAL", colorNameAr: "أخضر", colorNameEn: "Green" } });
  const vP2 = await prisma.productVariant.create({ data: { skuId: skuP2.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "500", defaultPurchasePricePerMeter: "400", avgCost: "1600", avgCostPerMeter: "400" } });
  await prisma.branchInventoryBalance.create({ data: { branchId: branch.id, productVariantId: vP2.id, boardsOnHand: "10.0000", metersOnHand: "40.0000" } });
  const stockedPurchase2 = await prisma.purchaseInvoice.create({ data: {
    invoiceNumber: "PINV-E2E-ACCT", invoiceDate: new Date("2026-02-16"), supplierId: supplier.id, branchId: branch.id, status: "CONFIRMED",
    subtotal: "16000.00", taxAmount: "0", grandTotal: "16000.00", createdBy: owner.id,
    lines: { create: [{ productVariantId: vP2.id, boardsQuantity: "10", metersQuantity: "40.0000", unitPrice: "400.00", lineTotal: "16000.00", taxRate: "0", taxAmount: "0", unitCostAtPosting: "1600.00", taxRateAtPosting: "0" }] },
  } });

  const oldPurchaseId = purchaseIds[0]; // 2026-01-01 — OFF page 1
  // Pre-made CONFIRMED purchase return on the OLDEST purchase (deep-link display).
  const oldPurchaseLine = (await prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: oldPurchaseId } }))!;
  await prisma.purchaseReturn.create({ data: {
    originalPurchaseInvoiceId: oldPurchaseId, supplierId: supplier.id, branchId: branch.id,
    returnDate: new Date("2026-01-03"), status: "CONFIRMED", settlementMode: "KEEP_AS_SUPPLIER_CREDIT",
    subtotal: "1600.00", taxTotal: "0", grandTotal: "1600.00", inventoryValueOut: "1600.00", confirmedAt: new Date(), confirmedBy: owner.id, createdBy: owner.id,
    lines: { create: [{ originalPurchaseInvoiceLineId: oldPurchaseLine.id, productVariantId: vP.id, returnedBoards: "1.0000", returnedMetersQuantity: "4.0000", originalPurchasePricePerMeter: "400.00", originalTaxRate: "0", returnNetExTax: "1600.00", returnTax: "0", returnTotal: "1600.00", historicalInventoryCostPerMeter: "400.0000", inventoryValueOut: "1600.00" }] },
  } });

  // A DRAFT PURCHASE return so the BRANCH_MANAGER can VIEW one and we can assert
  // it exposes NO edit/confirm/cancel buttons on the purchase side (§5).
  const pMgrLine = (await prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: purchaseIds[5] } }))!;
  const purchaseManagerDraft = await prisma.purchaseReturn.create({ data: {
    originalPurchaseInvoiceId: purchaseIds[5], supplierId: supplier.id, branchId: branch.id,
    returnDate: new Date("2026-01-06"), status: "DRAFT", settlementMode: "KEEP_AS_SUPPLIER_CREDIT",
    subtotal: "1600.00", taxTotal: "0", grandTotal: "1600.00", inventoryValueOut: "1600.00", createdBy: owner.id,
    lines: { create: [{ originalPurchaseInvoiceLineId: pMgrLine.id, productVariantId: vP.id, returnedBoards: "1.0000", returnedMetersQuantity: "4.0000", originalPurchasePricePerMeter: "400.00", originalTaxRate: "0", returnNetExTax: "1600.00", returnTax: "0", returnTotal: "1600.00", historicalInventoryCostPerMeter: "400.0000", inventoryValueOut: "1600.00" }] },
  } });

  const num = async (id: string) => (await prisma.salesInvoice.findUnique({ where: { id }, select: { invoiceNumber: true } }))!.invoiceNumber.toString();
  const fixture = {
    password: PASSWORD, ownerPhone: OWNER_PHONE, accountantPhone: ACCOUNTANT_PHONE, managerPhone: MANAGER_PHONE,
    oldSaleId, oldSaleNumber: await num(oldSaleId),
    freshSaleOwner, freshSaleOwnerNumber: await num(freshSaleOwner),
    freshSaleAccountant, freshSaleAccountantNumber: await num(freshSaleAccountant),
    freshSaleManager, freshSaleManagerNumber: await num(freshSaleManager),
    overReturnSaleId, overReturnSaleNumber: await num(overReturnSaleId),
    legacySaleId: legacy.id, legacySaleNumber: await num(legacy.id),
    managerDraftReturnId: managerDraft.id,
    oldPurchaseId, stockedPurchaseId: stockedPurchase.id, stockedPurchaseNumber: "PINV-E2E-STOCK",
    stockedPurchase2Id: stockedPurchase2.id, stockedPurchase2Number: "PINV-E2E-ACCT",
    purchaseManagerDraftReturnId: purchaseManagerDraft.id,
    branchBPhone: BRANCH_B_PHONE, branchBId: branchB.id,
  };
  writeFileSync("/tmp/shorok-e2e-fixture.json", JSON.stringify(fixture, null, 2));
  // eslint-disable-next-line no-console
  console.log("E2E seed ok:", JSON.stringify({ sales: saleIds.length, purchases: purchaseIds.length, oldSaleId, oldPurchaseId }));
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
