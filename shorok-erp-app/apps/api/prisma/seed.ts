import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

const DEMO_OWNER_PHONE = "+201000000000";
const DEMO_OWNER_PASSWORD = "Owner@2026";
const BCRYPT_COST = 12;

async function main() {
  // System settings (single-row, idempotent)
  await prisma.systemSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      defaultPriceOverrideTolerancePercent: "5.00",
      lowStockThresholdBoards: "5",
    },
  });

  // Demo branch
  const branch = await prisma.branch.upsert({
    where: { nameAr: "الفرع الرئيسي" },
    update: {},
    create: {
      nameAr: "الفرع الرئيسي",
      nameEn: "Main Branch",
      location: "Cairo",
      active: true,
    },
  });

  // Demo OWNER (idempotent on phone)
  const passwordHash = await bcrypt.hash(DEMO_OWNER_PASSWORD, BCRYPT_COST);
  const owner = await prisma.user.upsert({
    where: { phone: DEMO_OWNER_PHONE },
    update: {},
    create: {
      name: "Demo Owner",
      phone: DEMO_OWNER_PHONE,
      passwordHash,
      role: "OWNER",
      status: "ACTIVE",
    },
  });

  // OWNER bypasses BranchScopeGuard, but seed an explicit grant so listings
  // that JOIN UserBranchAccess still see the demo branch for this user.
  await prisma.userBranchAccess.upsert({
    where: { userId_branchId: { userId: owner.id, branchId: branch.id } },
    update: {},
    create: { userId: owner.id, branchId: branch.id },
  });

  // 3 SKUs × 2 variants each (sizes 4 and 5.25 m/board)
  const skuSeeds = [
    { code: "RED-01", colorNameAr: "أحمر", colorNameEn: "Red" },
    { code: "BLU-01", colorNameAr: "أزرق", colorNameEn: "Blue" },
    { code: "GRN-01", colorNameAr: "أخضر", colorNameEn: "Green" },
  ];
  const sizes = ["4", "5.25"] as const;

  for (const s of skuSeeds) {
    const sku = await prisma.productSku.upsert({
      where: { code: s.code },
      update: {},
      create: { ...s, category: "NORMAL", active: true },
    });
    for (const size of sizes) {
      await prisma.productVariant.upsert({
        where: {
          skuId_sizeMetersPerBoard: {
            skuId: sku.id,
            sizeMetersPerBoard: size,
          },
        },
        update: {},
        create: {
          skuId: sku.id,
          sizeMetersPerBoard: size,
          defaultSalePricePerMeter: "120.00",
          defaultPurchasePricePerMeter: "90.00",
          priceOverrideTolerancePercent: null,
          active: true,
        },
      });
    }
  }

  // Demo supplier
  await prisma.supplier.upsert({
    where: { nameAr: "المصنع الرئيسي" },
    update: {},
    create: {
      nameAr: "المصنع الرئيسي",
      nameEn: "Main Factory",
      active: true,
    },
  });

  console.log("Seed complete:");
  console.log(`  OWNER phone:    ${DEMO_OWNER_PHONE}`);
  console.log(`  OWNER password: ${DEMO_OWNER_PASSWORD}`);
  console.log(`  Branch:         ${branch.nameEn}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
