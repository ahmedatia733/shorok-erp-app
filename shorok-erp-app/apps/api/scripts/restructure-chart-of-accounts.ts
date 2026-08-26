/**
 * Turns the Chart of Accounts into a real hierarchy.
 *
 * The chart already had `parentId`, `isLeaf` and `systemRole` columns — only six
 * of forty-six accounts were ever linked, so the tree existed on paper while the
 * reports fell back to guessing structure from code prefixes and account names.
 * This script fills that hierarchy in, and nothing else.
 *
 * What it deliberately never does:
 *
 *   - change an Account.id. Sales and purchase invoices snapshot the account
 *     ids they posted to (87 and 14 documents respectively), treasuries point at
 *     their GL account, and every journal line references an id. Re-keying an
 *     account would silently detach history from it.
 *   - change the code of an account that is in use.
 *   - write, move or recompute a single balance. Hierarchy is presentation;
 *     debits and credits are untouched, so totals before and after are identical.
 *   - touch journal_lines, invoices, returns, inventory or parties.
 *
 * An account only becomes a non-posting header if it has never carried a
 * journal line and nothing references it as a posting destination — asserted
 * here rather than assumed, because a header that already has history would
 * strand that history under a row nobody can post to.
 *
 * Idempotent: accounts are resolved by their unique code, every write is a
 * convergence toward the target, and a second run reports zero changes.
 *
 *   pnpm --filter @shorok/api coa:restructure -- [--execute]
 *
 * Without --execute it prints the exact plan and writes nothing.
 */
import { PrismaClient } from "@prisma/client";

type Cat = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "COST_OF_SALES" | "EXPENSE";
type AType = "FIXED_ASSET" | "CURRENT_ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "COST_OF_SALES" | "EXPENSE";

interface Target {
  code: string;
  parent: string | null;
  isLeaf: boolean;
  /** Only set when the account must be created if absent. */
  create?: { nameAr: string; nameEn: string; category: Cat; accountType: AType };
  /** Only set when an existing structural account is being repurposed. */
  renameAr?: string;
}

/**
 * The target chart. Order matters only for readability — parents are resolved
 * by code after every account exists.
 */
const TARGET: Target[] = [
  // ── assets ───────────────────────────────────────────────────────────────
  { code: "1000", parent: null,   isLeaf: false },
  { code: "1100", parent: "1000", isLeaf: false },
  { code: "1110", parent: "1100", isLeaf: true },
  { code: "1120", parent: "1100", isLeaf: true },
  { code: "1130", parent: "1100", isLeaf: true },
  { code: "1140", parent: "1100", isLeaf: true,
    create: { nameAr: "مجمع الإهلاك", nameEn: "Accumulated Depreciation", category: "ASSET", accountType: "FIXED_ASSET" } },
  { code: "1200", parent: "1000", isLeaf: false },
  // Repurposed: it held no activity and its old name duplicated a treasury.
  { code: "1210", parent: "1200", isLeaf: false, renameAr: "النقدية والبنوك" },
  { code: "1211", parent: "1210", isLeaf: false, renameAr: "الخزن" },
  { code: "CASH",   parent: "1211", isLeaf: true },
  { code: "CASH-1", parent: "1211", isLeaf: true },
  { code: "CASH-2", parent: "1211", isLeaf: true },
  { code: "CASH-3", parent: "1211", isLeaf: true },
  { code: "CASH-4", parent: "1211", isLeaf: true },
  { code: "1220", parent: "1210", isLeaf: false },
  { code: "1221", parent: "1220", isLeaf: true },
  { code: "1222", parent: "1220", isLeaf: true },
  { code: "1223", parent: "1220", isLeaf: true },
  { code: "1230", parent: "1200", isLeaf: true },
  { code: "1240", parent: "1200", isLeaf: false },
  { code: "AR-CONTROL", parent: "1240", isLeaf: true },
  { code: "1250", parent: "1200", isLeaf: false },
  { code: "INVENTORY-CONTROL", parent: "1250", isLeaf: true },
  { code: "1260", parent: "1200", isLeaf: true },

  // ── liabilities ──────────────────────────────────────────────────────────
  { code: "2000", parent: null,   isLeaf: false },
  { code: "2100", parent: "2000", isLeaf: true },
  { code: "2200", parent: "2000", isLeaf: true },
  { code: "2300", parent: "2000", isLeaf: true },
  { code: "2400", parent: "2000", isLeaf: true,
    create: { nameAr: "قروض والتزامات طويلة الأجل", nameEn: "Loans and Long-term Liabilities", category: "LIABILITY", accountType: "LIABILITY" } },

  // ── equity ───────────────────────────────────────────────────────────────
  { code: "3000", parent: null,   isLeaf: false },
  { code: "3100", parent: "3000", isLeaf: true },
  { code: "3200", parent: "3000", isLeaf: true },
  { code: "3300", parent: "3000", isLeaf: true },
  { code: "3400", parent: "3000", isLeaf: true },
  // Historical cutover equity: parented for presentation, otherwise untouched.
  { code: "CUTOVER-TEMP-EQUITY", parent: "3000", isLeaf: true },

  // ── revenue ──────────────────────────────────────────────────────────────
  { code: "4000", parent: null,   isLeaf: false },
  { code: "4100", parent: "4000", isLeaf: true },
  { code: "4200", parent: "4000", isLeaf: true },
  { code: "4300", parent: "4000", isLeaf: true,
    create: { nameAr: "إيرادات أخرى", nameEn: "Other Revenue", category: "REVENUE", accountType: "REVENUE" } },

  // ── cost of sales ────────────────────────────────────────────────────────
  { code: "5000", parent: null,   isLeaf: false },
  { code: "5100", parent: "5000", isLeaf: true },

  // ── expenses ─────────────────────────────────────────────────────────────
  { code: "6000", parent: null,   isLeaf: false },
  { code: "6010", parent: "6000", isLeaf: false,
    create: { nameAr: "مصروفات البيع والتوزيع", nameEn: "Selling and Distribution Expenses", category: "EXPENSE", accountType: "EXPENSE" } },
  { code: "6100", parent: "6010", isLeaf: true },
  { code: "6020", parent: "6000", isLeaf: false,
    create: { nameAr: "المصروفات العمومية والإدارية", nameEn: "General and Administrative Expenses", category: "EXPENSE", accountType: "EXPENSE" } },
  { code: "6200", parent: "6020", isLeaf: true },
  { code: "6300", parent: "6020", isLeaf: true },
  { code: "6400", parent: "6020", isLeaf: true },
  { code: "6700", parent: "6020", isLeaf: true },
  { code: "6030", parent: "6000", isLeaf: false,
    create: { nameAr: "المصروفات البنكية والتمويلية", nameEn: "Banking and Finance Expenses", category: "EXPENSE", accountType: "EXPENSE" } },
  { code: "6500", parent: "6030", isLeaf: true },
  { code: "6040", parent: "6000", isLeaf: false,
    create: { nameAr: "مصروفات أخرى", nameEn: "Other Expenses", category: "EXPENSE", accountType: "EXPENSE" } },
  { code: "6600", parent: "6040", isLeaf: true },
  { code: "6050", parent: "6000", isLeaf: false,
    create: { nameAr: "الإهلاك", nameEn: "Depreciation", category: "EXPENSE", accountType: "EXPENSE" } },
  { code: "6800", parent: "6050", isLeaf: true,
    create: { nameAr: "مصروف الإهلاك", nameEn: "Depreciation Expense", category: "EXPENSE", accountType: "EXPENSE" } },
];

/**
 * System roles worth recording. Only roles whose meaning is proven by an
 * existing PostingProfile mapping or by an unambiguous account identity, and
 * whose consumers were read first.
 *
 * AP_CONTROL is the only one with behaviour attached — it makes a manual
 * journal line to that account require a supplier party, and it is what the
 * supplier statement filters on. Every one of 2100's existing lines already
 * carries a party, so this matches how the account is already used.
 *
 * VAT_INPUT / VAT_OUTPUT / DISCOUNT / ROUNDING / SHRINKAGE are deliberately
 * absent: see the rollout report.
 */
const ROLES: Array<{ code: string; role: string; why: string }> = [
  { code: "2100", role: "AP_CONTROL",        why: "PostingProfile.apAccountId already resolves here; all 20 lines carry a supplier party" },
  { code: "4100", role: "REVENUE",           why: "PostingProfile.revenueAccountId already resolves here" },
  { code: "5100", role: "COGS",              why: "PostingProfile.cogsAccountId already resolves here" },
  { code: "3300", role: "RETAINED_EARNINGS", why: "الأرباح المحتجزة — sole retained-earnings account, no activity" },
  { code: "3400", role: "OPENING_EQUITY",    why: "رصيد افتتاحي — sole opening-equity account, no activity" },
];

const execute = process.argv.includes("--execute");
const prisma = new PrismaClient();

async function main() {
  const changes: string[] = [];
  const fail = (m: string) => { throw new Error(`PRECONDITION FAILED: ${m}`); };

  await prisma.$transaction(async (tx) => {
    const before = await tx.account.findMany({
      select: { id: true, code: true, nameAr: true, parentId: true, isLeaf: true, systemRole: true },
    });
    const byCode = new Map(before.map((a) => [a.code, a]));
    if (byCode.size !== before.length) fail("duplicate account codes exist");

    // ── preconditions ──────────────────────────────────────────────────────
    // Anything becoming a header must never have carried a journal line, and
    // must not be referenced as a posting destination by a document snapshot,
    // a treasury or a posting profile.
    for (const t of TARGET.filter((x) => !x.isLeaf)) {
      const acc = byCode.get(t.code);
      if (!acc) continue; // created below, so it has no history by construction
      const lines = await tx.journalLine.count({ where: { accountId: acc.id } });
      if (lines > 0) fail(`${t.code} would become a header but has ${lines} journal lines`);
      const treasuries = await tx.treasury.count({ where: { glAccountId: acc.id } });
      if (treasuries > 0) fail(`${t.code} would become a header but ${treasuries} treasuries point at it`);
      const profiles = await tx.postingProfile.count({
        where: { OR: [
          { arAccountId: acc.id }, { apAccountId: acc.id }, { revenueAccountId: acc.id },
          { salesReturnsAccountId: acc.id }, { cogsAccountId: acc.id }, { inventoryAccountId: acc.id },
          { vatInputAccountId: acc.id }, { vatOutputAccountId: acc.id },
        ] },
      });
      if (profiles > 0) fail(`${t.code} would become a header but ${profiles} posting profiles reference it`);
      const si = await tx.salesInvoice.count({
        where: { OR: [
          { revenueAccountId: acc.id }, { arAccountId: acc.id }, { cogsAccountId: acc.id },
          { inventoryAccountId: acc.id }, { taxAccountId: acc.id },
        ] },
      });
      const pi = await tx.purchaseInvoice.count({
        where: { OR: [{ apAccountId: acc.id }, { inventoryAccountId: acc.id }, { taxAccountId: acc.id }] },
      });
      if (si + pi > 0) fail(`${t.code} would become a header but ${si + pi} documents snapshot it as a posting account`);
    }

    // ── 1. create genuinely missing accounts ───────────────────────────────
    for (const t of TARGET) {
      if (byCode.has(t.code)) continue;
      if (!t.create) fail(`${t.code} is missing from the chart and this script has no definition to create it`);
      if (!execute) {
        changes.push(`CREATE  ${t.code}  ${t.create.nameAr}  (${t.create.category})`);
        // Model the account so the rest of the plan can resolve it as a parent.
        byCode.set(t.code, { id: `planned:${t.code}`, code: t.code, nameAr: t.create.nameAr, parentId: null, isLeaf: t.isLeaf, systemRole: null });
        continue;
      }
      const created = await tx.account.create({
        data: {
          code: t.code, nameAr: t.create!.nameAr, nameEn: t.create!.nameEn,
          category: t.create!.category as never, accountType: t.create!.accountType as never,
          isLeaf: t.isLeaf, active: true,
        },
        select: { id: true, code: true, nameAr: true, parentId: true, isLeaf: true, systemRole: true },
      });
      byCode.set(t.code, created);
      changes.push(`CREATE  ${t.code}  ${t.create!.nameAr}`);
    }

    // ── 2. names of repurposed structural accounts ─────────────────────────
    for (const t of TARGET) {
      if (!t.renameAr) continue;
      const acc = byCode.get(t.code)!;
      if (acc.nameAr === t.renameAr) continue;
      changes.push(`RENAME  ${t.code}  «${acc.nameAr}» -> «${t.renameAr}»`);
      if (execute) await tx.account.update({ where: { id: acc.id }, data: { nameAr: t.renameAr } });
    }

    // ── 3. parent links and leaf flags ─────────────────────────────────────
    for (const t of TARGET) {
      const acc = byCode.get(t.code);
      if (!acc) fail(`${t.code} still missing after creation`);
      const parentId = t.parent ? byCode.get(t.parent)?.id ?? null : null;
      if (t.parent && !parentId) fail(`parent ${t.parent} of ${t.code} does not exist`);
      if (parentId && parentId === acc.id) fail(`${t.code} would be its own parent`);

      if ((acc.parentId ?? null) !== parentId) {
        const from = before.find((b) => b.id === acc.parentId)?.code ?? "none";
        changes.push(`PARENT  ${t.code}  ${from} -> ${t.parent ?? "root"}`);
        if (execute) await tx.account.update({ where: { id: acc.id }, data: { parentId } });
      }
      if (acc.isLeaf !== t.isLeaf) {
        changes.push(`ISLEAF  ${t.code}  ${acc.isLeaf} -> ${t.isLeaf}`);
        if (execute) await tx.account.update({ where: { id: acc.id }, data: { isLeaf: t.isLeaf } });
      }
    }

    // ── 4. system roles ────────────────────────────────────────────────────
    for (const r of ROLES) {
      const acc = byCode.get(r.code);
      if (!acc) fail(`role ${r.role} targets missing account ${r.code}`);
      if (acc.systemRole === r.role) continue;
      if (acc.systemRole) fail(`${r.code} already owns role ${acc.systemRole}; refusing to overwrite`);
      const holder = before.find((b) => b.systemRole === r.role);
      if (holder && holder.code !== r.code) fail(`role ${r.role} is already held by ${holder.code}`);
      const target = TARGET.find((t) => t.code === r.code);
      if (target && !target.isLeaf) fail(`role ${r.role} targets ${r.code} which is a header`);
      changes.push(`ROLE    ${r.code}  none -> ${r.role}   (${r.why})`);
      if (execute) await tx.account.update({ where: { id: acc.id }, data: { systemRole: r.role as never } });
    }

    // ── 5. post-conditions, inside the same transaction ────────────────────
    if (execute) {
      const after = await tx.account.findMany({ select: { id: true, code: true, parentId: true, isLeaf: true } });
      const byId = new Map(after.map((a) => [a.id, a]));
      for (const a of after) {
        const seen = new Set<string>([a.id]);
        let cur = a.parentId;
        while (cur) {
          if (seen.has(cur)) fail(`cycle detected at ${a.code}`);
          seen.add(cur);
          cur = byId.get(cur)?.parentId ?? null;
        }
      }
      for (const b of before) {
        const now = byId.get(b.id);
        if (!now) fail(`account ${b.code} disappeared`);
        if (now.code !== b.code) fail(`account ${b.id} changed code ${b.code} -> ${now.code}`);
      }
      const leavesWithChildren = after.filter((a) => a.isLeaf && after.some((c) => c.parentId === a.id));
      if (leavesWithChildren.length) fail(`leaf accounts have children: ${leavesWithChildren.map((a) => a.code).join(",")}`);
    }
  }, { timeout: 120_000 });

  console.log(execute ? "APPLIED:" : "DRY RUN — nothing was written:");
  if (changes.length === 0) console.log("  (already converged — no changes needed)");
  for (const c of changes) console.log("  " + c);
  console.log(`\n${changes.length} change(s)`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); })
  .finally(() => void prisma.$disconnect());
