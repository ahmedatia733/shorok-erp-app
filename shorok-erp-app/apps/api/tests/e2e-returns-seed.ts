/**
 * E2E fixture seed for the RETURNS browser tests. Runs ONLY against
 * TEST_DATABASE_URL (a dedicated local test database) — it refuses to run
 * anywhere else. Truncates the public schema and seeds a deterministic dataset:
 * an OWNER login, a confirmed sales invoice (returnable), a second confirmed
 * sale, and a confirmed purchase invoice with stock (for a purchase return).
 */
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";

const url = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(url) || !/test/i.test(url)) {
  throw new Error(`Refusing to seed a non-local / non-test database: ${url.replace(/:[^:@/]*@/, ":***@")}`);
}
const prisma = new PrismaClient();

export const OWNER_PHONE = "+201555000099";
export const OWNER_PASSWORD = "E2eOwner@2026";

async function main() {
  await prisma.$executeRawUnsafe(`DO $$ DECLARE r RECORD; BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations') LOOP
      EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
    END LOOP; END $$;`);

  const owner = await prisma.user.create({ data: { name: "مالك الاختبار", phone: OWNER_PHONE, passwordHash: await bcrypt.hash(OWNER_PASSWORD, 10), role: "OWNER", status: "ACTIVE" } });
  const branch = await prisma.branch.create({ data: { nameAr: "فرع الاختبار", nameEn: "Test Branch", active: true } });
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

  // Sales variant (sold out; the return will restock it).
  const skuS = await prisma.productSku.create({ data: { code: "E2E-RED", category: "NORMAL", colorNameAr: "أحمر", colorNameEn: "Red" } });
  const vS = await prisma.productVariant.create({ data: { skuId: skuS.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "500", defaultPurchasePricePerMeter: "300", avgCost: "1200", avgCostPerMeter: "300" } });

  const confirmedSale = (n: number) => prisma.salesInvoice.create({ data: {
    invoiceDate: new Date("2026-03-01"), customerId: customer.id, branchId: branch.id, salesRepresentativeId: rep.id,
    status: "CONFIRMED", subtotal: "10000.00", discountAmount: "0", taxRate: "0", taxAmount: "0", grandTotal: "10000.00", totalCost: "6000.00", createdBy: owner.id,
    lines: { create: [{ productVariantId: vS.id, quantity: "5", metersQuantity: "20.0000", unitLabel: "متر", unitPrice: "500.00", costPrice: "0", discountPct: "0", lineTotal: "10000.00", lineCost: "0", unitCostAtPosting: "1200.00", unitCostPerMeterAtPosting: "300.0000", lineCogsAtPosting: "6000.00", taxRateAtPosting: "0" }] },
  }, include: { lines: true } });
  const sale1 = await confirmedSale(1);
  await confirmedSale(2); // a second confirmed sale (for search / deep-link)

  // Purchase variant WITH stock, so a purchase return can remove it.
  const skuP = await prisma.productSku.create({ data: { code: "E2E-BLU", category: "NORMAL", colorNameAr: "أزرق", colorNameEn: "Blue" } });
  const vP = await prisma.productVariant.create({ data: { skuId: skuP.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "500", defaultPurchasePricePerMeter: "400", avgCost: "1600", avgCostPerMeter: "400" } });
  await prisma.branchInventoryBalance.create({ data: { branchId: branch.id, productVariantId: vP.id, boardsOnHand: "10.0000", metersOnHand: "40.0000" } });
  await prisma.purchaseInvoice.create({ data: {
    invoiceNumber: "PINV-E2E-1", invoiceDate: new Date("2026-02-01"), supplierId: supplier.id, branchId: branch.id, status: "CONFIRMED",
    subtotal: "16000.00", taxAmount: "0", grandTotal: "16000.00", createdBy: owner.id,
    lines: { create: [{ productVariantId: vP.id, boardsQuantity: "10", metersQuantity: "40.0000", unitPrice: "400.00", lineTotal: "16000.00", taxRate: "0", taxAmount: "0", unitCostAtPosting: "1600.00", taxRateAtPosting: "0" }] },
  } });

  // eslint-disable-next-line no-console
  console.log(`E2E seed ok: sale1=${sale1.invoiceNumber} owner=${OWNER_PHONE}`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
