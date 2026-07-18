/**
 * Reusable opening-import mechanics (no CLI side effects) — used by the import
 * script and the integration test. Resolves the branches/accounts context, runs
 * the atomic reset + import through the canonical InventoryEngine + PostingEngine,
 * and reconciles inside the transaction.
 */
import { Decimal } from "decimal.js";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { PostingEngine } from "../src/modules/posting/posting.engine";
import type { InventoryEngine } from "../src/modules/inventory/inventory.engine";
import type { AuthenticatedUser } from "../src/common/types/request-user";
import {
  CUSTOMERS, EXPECT, IK_CUSTOMERS, IK_INVENTORY, MARKER, OPENING_DATE, PRODUCTS, VARIANTS,
  D, money, sizeOf,
} from "./opening-dataset";

const OPERATIONAL_TABLES = "customers, product_skus, journal_entries, payments";

export interface Ctx {
  prisma: PrismaService; posting: PostingEngine; inventory: InventoryEngine; actor: AuthenticatedUser;
  waraqId: string; waraqName: string; sohagId: string; sohagName: string;
  arAccountId: string; arLabel: string; invAccountId: string; invLabel: string; oeAccountId: string; oeLabel: string;
}

export async function resolveContext(prisma: PrismaService, posting: PostingEngine, inventory: InventoryEngine): Promise<Ctx> {
  const owner = await prisma.user.findFirst({ where: { role: "OWNER" as never, status: "ACTIVE" as never } });
  if (!owner) throw new Error("No active OWNER user found.");
  const actor: AuthenticatedUser = { id: owner.id, name: owner.name, phone: owner.phone, email: owner.email, role: owner.role, status: owner.status, allowedBranches: [] };

  const branches = await prisma.branch.findMany();
  const resolveBranch = (needle: string) => {
    const m = branches.filter((b) => b.nameAr.replace(/\s+/g, "").includes(needle.replace(/\s+/g, "")));
    if (m.length === 0) throw new Error(`Branch "${needle}" not found.`);
    if (m.length > 1) throw new Error(`Branch "${needle}" is ambiguous (${m.length} matches).`);
    if (!m[0].active) throw new Error(`Branch "${needle}" (${m[0].nameAr}) is inactive.`);
    return m[0];
  };
  const waraq = resolveBranch("الوراق");
  const sohag = resolveBranch("سوهاج");
  if (waraq.id === sohag.id) throw new Error("الوراق and سوهاج resolved to the same branch.");

  const profile = await prisma.postingProfile.findFirst({ orderBy: { effectiveFrom: "desc" } });
  const byRole = (role: string) => prisma.account.findFirst({ where: { systemRole: role as never, active: true } });
  const byId = (id?: string | null) => (id ? prisma.account.findUnique({ where: { id } }) : Promise.resolve(null));

  const ar = (await byRole("AR_CONTROL")) ?? (await byId(profile?.arAccountId));
  if (!ar) throw new Error("AR_CONTROL account not resolved.");
  const inv = (await byRole("INVENTORY")) ?? (await byId(profile?.inventoryAccountId));
  if (!inv) throw new Error("INVENTORY account not resolved.");
  let oe = (await byRole("OPENING_EQUITY")) ?? (await byId(profile?.openingEquityAccountId))
        ?? (await prisma.account.findFirst({ where: { code: "3400" } }));
  if (!oe) oe = await prisma.account.findFirst({ where: { category: "EQUITY" as never, isLeaf: true, active: true }, orderBy: { code: "asc" } });
  if (!oe) throw new Error("OPENING_EQUITY / equity account not resolved.");
  for (const [label, a] of [["AR", ar], ["INVENTORY", inv], ["OPENING_EQUITY", oe]] as const) {
    if (!a.isLeaf || !a.active) throw new Error(`${label} account ${a.code} must be an active leaf.`);
  }
  return {
    prisma, posting, inventory, actor,
    waraqId: waraq.id, waraqName: waraq.nameAr, sohagId: sohag.id, sohagName: sohag.nameAr,
    arAccountId: ar.id, arLabel: `${ar.code} — ${ar.nameAr}`, invAccountId: inv.id, invLabel: `${inv.code} — ${inv.nameAr}`,
    oeAccountId: oe.id, oeLabel: `${oe.code} — ${oe.nameAr}`,
  };
}

export async function alreadyApplied(prisma: PrismaService): Promise<boolean> {
  return !!(await prisma.journalEntry.findUnique({ where: { idempotencyKey: IK_CUSTOMERS } }));
}

export async function importOpening(ctx: Ctx): Promise<void> {
  await ctx.prisma.runInTransaction(async (tx: any) => {
    // 1. Operational-data cleanup (CASCADE wipes all operational children).
    await tx.$executeRawUnsafe(`TRUNCATE TABLE ${OPERATIONAL_TABLES} RESTART IDENTITY CASCADE;`);

    // 2+3. SKUs + variants (avgCost per board = size × price/meter → COGS-consistent).
    const skuIdByCode = new Map<string, string>();
    for (const [code, name] of PRODUCTS) {
      const sku = await tx.productSku.create({ data: { code, colorNameAr: name, colorNameEn: "", category: "NORMAL" } });
      skuIdByCode.set(code, sku.id);
    }
    const variantId = new Map<string, string>();
    for (const v of VARIANTS) {
      const size = sizeOf(v);
      const created = await tx.productVariant.create({
        data: {
          skuId: skuIdByCode.get(v.code)!, sizeMetersPerBoard: size.toFixed(4),
          defaultSalePricePerMeter: D(v.price).toFixed(2), defaultPurchasePricePerMeter: D(v.price).toFixed(2),
          avgCost: size.mul(v.price).toFixed(4), costUpdatedAt: new Date(OPENING_DATE),
        },
      });
      variantId.set(`${v.code}|${size.toFixed(4)}`, created.id);
    }

    // 4. Customers (canonical C-#### in listed order).
    const custId = new Map<string, string>();
    let seq = 0;
    for (const c of CUSTOMERS) {
      seq += 1;
      const created = await tx.customer.create({ data: { code: `C-${String(seq).padStart(4, "0")}`, nameAr: c.name, phone: null, active: true } });
      custId.set(c.name, created.id);
    }

    // 5. Opening stock via the canonical InventoryEngine.
    const openingCreatedAt = new Date(`${OPENING_DATE}T00:00:00.000Z`);
    for (const v of VARIANTS) {
      const vId = variantId.get(`${v.code}|${sizeOf(v).toFixed(4)}`)!;
      for (const [branchId, boards, tag] of [[ctx.waraqId, v.waraqBoards, "WARAQ"], [ctx.sohagId, v.sohagBoards, "SOHAG"]] as const) {
        if (D(boards).lte(0)) continue;
        await ctx.inventory.apply({
          tx, branchId, productVariantId: vId, movementType: "RECEIPT",
          boardsDelta: D(boards).toFixed(4), actor: ctx.actor, createdAt: openingCreatedAt,
          reference: { type: "OPENING_STOCK", id: null }, humanReadableNote: `OPENING-STOCK-${tag}-20260718`,
          summaryAr: `رصيد افتتاحي للمخزون — ${v.code} ${v.item}`, summaryEn: `Opening stock — ${v.code} ${v.item}`,
        });
      }
    }

    // 6. Opening inventory journal (Dr Inventory per branch / Cr Opening Equity).
    const waraqVal = VARIANTS.reduce((a, v) => a.add(D(v.waraqMeters).mul(v.price)), D(0));
    const sohagVal = VARIANTS.reduce((a, v) => a.add(D(v.sohagMeters).mul(v.price)), D(0));
    await ctx.posting.post({
      tx, actor: ctx.actor, sourceType: "OPENING", entryType: "OPENING", entryDate: OPENING_DATE,
      reference: "OPENING-STOCK-20260718", idempotencyKey: IK_INVENTORY, description: "رصيد افتتاحي للمخزون 2026-07-18",
      lines: [
        { accountId: ctx.invAccountId, debit: money(waraqVal), credit: "0", branchId: ctx.waraqId, note: `مخزون افتتاحي — ${ctx.waraqName}` },
        { accountId: ctx.invAccountId, debit: money(sohagVal), credit: "0", branchId: ctx.sohagId, note: `مخزون افتتاحي — ${ctx.sohagName}` },
        { accountId: ctx.oeAccountId, debit: "0", credit: money(waraqVal.add(sohagVal)), note: "رصيد افتتاحي — مقابل المخزون" },
      ],
    });

    // 7. Opening customer journal (Dr/Cr AR[party] per customer / Cr Opening Equity).
    const debitTotal = CUSTOMERS.filter((c) => c.side === "DEBIT").reduce((a, c) => a.add(c.amount), D(0));
    const creditTotal = CUSTOMERS.filter((c) => c.side === "CREDIT").reduce((a, c) => a.add(c.amount), D(0));
    await ctx.posting.post({
      tx, actor: ctx.actor, sourceType: "OPENING", entryType: "OPENING", entryDate: OPENING_DATE,
      reference: "OPENING-CUSTOMERS-20260718", idempotencyKey: IK_CUSTOMERS, description: "أرصدة افتتاحية للعملاء 2026-07-18",
      lines: [
        ...CUSTOMERS.map((c) => ({
          accountId: ctx.arAccountId,
          debit: c.side === "DEBIT" ? money(D(c.amount)) : "0", credit: c.side === "CREDIT" ? money(D(c.amount)) : "0",
          partyType: "CUSTOMER" as const, partyId: custId.get(c.name)!, note: `رصيد افتتاحي — ${c.name}`,
        })),
        { accountId: ctx.oeAccountId, debit: "0", credit: money(debitTotal.sub(creditTotal)), note: "رصيد افتتاحي — مقابل أرصدة العملاء" },
      ],
    });

    // 8. Reconcile inside the transaction — throw (→ rollback) on any mismatch.
    await reconcile(tx, ctx);
  }, { timeoutMs: 180_000 });
}

export async function reconcile(tx: any, ctx: Ctx): Promise<string[]> {
  const errs: string[] = [];
  if ((await tx.productSku.count()) !== EXPECT.products) errs.push("sku count");
  if ((await tx.productVariant.count()) !== EXPECT.variants) errs.push("variant count");
  if ((await tx.customer.count()) !== EXPECT.customers) errs.push("customer count");

  const bal = await tx.branchInventoryBalance.groupBy({ by: ["branchId"], _sum: { boardsOnHand: true, metersOnHand: true } });
  const w = bal.find((b: any) => b.branchId === ctx.waraqId), s = bal.find((b: any) => b.branchId === ctx.sohagId);
  if (!w || !D(w._sum.boardsOnHand ?? 0).eq(EXPECT.waraq.boards) || !D(w._sum.metersOnHand ?? 0).eq(EXPECT.waraq.meters)) errs.push("الوراق stock");
  if (!s || !D(s._sum.boardsOnHand ?? 0).eq(EXPECT.sohag.boards) || !D(s._sum.metersOnHand ?? 0).eq(EXPECT.sohag.meters)) errs.push("سوهاج stock");

  const invAgg = await tx.journalLine.aggregate({ where: { accountId: ctx.invAccountId }, _sum: { debit: true, credit: true } });
  if (!D(invAgg._sum.debit ?? 0).sub(invAgg._sum.credit ?? 0).eq(EXPECT.combined.value)) errs.push("inventory GL");

  const arAgg = await tx.journalLine.aggregate({ where: { accountId: ctx.arAccountId, partyType: "CUSTOMER" }, _sum: { debit: true, credit: true } });
  if (!D(arAgg._sum.debit ?? 0).sub(arAgg._sum.credit ?? 0).eq(EXPECT.netAr)) errs.push("AR net");

  const all = await tx.journalLine.aggregate({ _sum: { debit: true, credit: true } });
  if (!D(all._sum.debit ?? 0).sub(all._sum.credit ?? 0).eq(0)) errs.push("trial balance");

  if ((await tx.journalEntry.count({ where: { sourceType: "OPENING" } })) !== 2) errs.push("opening journal count");

  if (errs.length) throw new Error("Reconciliation failed: " + errs.join(", "));
  return errs;
}

export { MARKER };
