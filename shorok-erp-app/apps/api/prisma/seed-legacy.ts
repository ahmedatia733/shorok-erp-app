import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

const DEMO_OWNER_PHONE = "+201000000000";
const DEMO_OWNER_PASSWORD = "Owner@2026";
const BCRYPT_COST = 12;

async function main() {
  console.log("Seeding legacy catalogs...");

  // System settings (single-row, idempotent)
  await prisma.systemSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      defaultPriceOverrideTolerancePercent: "15.00", // Allow higher deviation for legacy migration
      lowStockThresholdBoards: "5",
    },
  });

  // Demo OWNER
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

  // Legacy Branches
  const branches = [
    { nameAr: "فرع الوراق", nameEn: "Waraq Branch", location: "Giza" },
    { nameAr: "فرع سوهاج", nameEn: "Sohag Branch", location: "Sohag" },
    { nameAr: "الفرع الرئيسي", nameEn: "Main Branch", location: "Cairo" }
  ];

  for (const b of branches) {
    const branch = await prisma.branch.upsert({
      where: { nameAr: b.nameAr },
      update: {},
      create: {
        nameAr: b.nameAr,
        nameEn: b.nameEn,
        location: b.location,
        active: true,
      },
    });

    // Ensure owner has access to all seeded branches
    await prisma.userBranchAccess.upsert({
      where: { userId_branchId: { userId: owner.id, branchId: branch.id } },
      update: {},
      create: { userId: owner.id, branchId: branch.id },
    });
  }

  // Legacy Suppliers
  const suppliers = [
    { nameAr: "المصنع الرئيسي", nameEn: "Main Factory" },
    { nameAr: "عم نايف", nameEn: "Naif Account" },
    { nameAr: "شروق", nameEn: "Shorok Account" }
  ];

  for (const s of suppliers) {
    await prisma.supplier.upsert({
      where: { nameAr: s.nameAr },
      update: {},
      create: {
        nameAr: s.nameAr,
        nameEn: s.nameEn,
        active: true,
      },
    });
  }

  // Legacy products list
  const legacySkus = [
    { code: "120", colorAr: "سيلفر", colorEn: "Silver", category: "NORMAL" as const },
    { code: "250", colorAr: "دارك جراي", colorEn: "Dark Gray", category: "NORMAL" as const },
    { code: "115", colorAr: "رمادي ساده", colorEn: "Plain Gray", category: "NORMAL" as const },
    { code: "385", colorAr: "جراي فاتح", colorEn: "Light Gray", category: "NORMAL" as const },
    { code: "D1", colorAr: "ابيض لامع", colorEn: "Glossy White", category: "NORMAL" as const },
    { code: "788", colorAr: "ابيض مط", colorEn: "Matt White", category: "NORMAL" as const },
    { code: "9005", colorAr: "اسود لامع", colorEn: "Glossy Black", category: "NORMAL" as const },
    { code: "9010", colorAr: "اسود مط", colorEn: "Matt Black", category: "NORMAL" as const },
    { code: "113", colorAr: "اوف وايت", colorEn: "Off White", category: "NORMAL" as const },
    { code: "442", colorAr: "بيج", colorEn: "Beige", category: "NORMAL" as const },
    { code: "276", colorAr: "احمر لامع", colorEn: "Glossy Red", category: "NORMAL" as const },
    { code: "1010", colorAr: "خشبي", colorEn: "Wooden", category: "SPECIAL" as const },
    { code: "302", colorAr: "مرايا دهبي", colorEn: "Gold Mirror", category: "SPECIAL" as const },
    { code: "1023", colorAr: "اصفر", colorEn: "Yellow", category: "SPECIAL" as const },
    { code: "116", colorAr: "كحلي", colorEn: "Navy", category: "SPECIAL" as const }
  ];

  const sizes = ["4.0000", "5.2500"];

  for (const s of legacySkus) {
    const sku = await prisma.productSku.upsert({
      where: { code: s.code },
      update: {},
      create: {
        code: s.code,
        colorNameAr: s.colorAr,
        colorNameEn: s.colorEn,
        category: s.category,
        active: true,
      },
    });

    for (const size of sizes) {
      const isSpecial = s.category === "SPECIAL";
      const purchasePrice = isSpecial ? "650.00" : "525.00";
      const salePrice = isSpecial ? "650.00" : "630.00";

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
          defaultSalePricePerMeter: salePrice,
          defaultPurchasePricePerMeter: purchasePrice,
          priceOverrideTolerancePercent: "15.00",
          active: true,
        },
      });
    }
  }

  console.log("Legacy seeding completed successfully!");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
