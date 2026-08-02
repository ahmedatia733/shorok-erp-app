/**
 * C6 — production-readiness corrections, proved against a real database:
 *
 *   Section 1  fresh-database preparation removes only the seeded demo rows
 *   Section 2  branch and actor are bound explicitly, never by findFirst()
 *   Section 4  opening customer balances really land on the customer statement
 *   Section 5  FULL_OPENING_IMPORT posts one balanced journal via PostingEngine
 *
 * Every fixture is SYNTHETIC. The real approved totals live only in the private
 * manifest and never appear in this repository.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";
import { CutoverService } from "../../src/modules/cutover/cutover.service";
import { ConsolidatedStatementService } from "../../src/modules/accounting-statements/consolidated-statement.service";
import { planCutover } from "../../src/modules/cutover/cutover-planner";
import { cutoverManifestSchema, type CutoverManifest } from "../../src/modules/cutover/manifest.schema";
import { CUTOVER_ERROR } from "../../src/modules/cutover/cutover.types";
import {
  prepareFreshDatabase,
  SEEDED_CUSTOMER_CODES,
  SEEDED_SKU_CODE_PREFIX,
} from "../../src/modules/cutover/fresh-db";

const CUTOVER = "2026-08-01";

let app: TestApp;
let service: CutoverService;
let statements: ConsolidatedStatementService;
let branchId: string;
let branchKey: string;
let actorUserId: string;
let actorPhone: string;
let arAccountCode: string;
let invAccountCode: string;
let eqAccountCode: string;

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function leafAccount(
  code: string,
  category: string,
  accountType: string,
  systemRole?: string,
) {
  return app.prisma.account.create({
    data: {
      code,
      nameAr: `حساب ${code}`,
      nameEn: `Account ${code}`,
      category: category as never,
      accountType: accountType as never,
      isLeaf: true,
      active: true,
      ...(systemRole ? { systemRole: systemRole as never } : {}),
    },
  });
}

/**
 * Debit customer 1000, credit customer 400, inventory 80 ⇒ Dr 1080 / Cr 400,
 * so the approved equity credit that balances it is exactly 680.
 */
function buildManifest(tag: string, over: Partial<CutoverManifest> = {}): CutoverManifest {
  const base = {
    manifestVersion: 1,
    manifestId: `SYN-${tag}`,
    cutoverDate: CUTOVER,
    importScope: "FULL_OPENING_IMPORT",
    branch: { approvedBranchId: branchId, approvedKey: branchKey, approvedNameAr: branchKey },
    actor: { approvedUserId: actorUserId, approvedPhone: actorPhone },
    sourceFiles: [{ id: "synthetic.xlsx", sha256: "d".repeat(64) }],
    approvedManifestFiles: [],
    datePolicy: "SWAP_DAY_MONTH_ON_DATE_CELLS_V1",
    inventoryValueBasis: "PRINTED_PDF_TOTAL",
    reversalPolicyReference: "A_PLUS_D",
    balancingPolicy: "REQUIRE_FULL_TRIAL_BALANCE",
    approver: "Synthetic Approver",
    approvalDate: CUTOVER,
    operator: "Synthetic Operator",
    unresolvedDecisions: 0,
    postingAccounts: { arControlCode: arAccountCode, inventoryControlCode: invAccountCode },
    expectedTotals: {
      customerDebitCount: 1,
      customerDebitTotal: 1000,
      customerCreditCount: 1,
      customerCreditTotal: 400,
      customerNetAr: 600,
      inventorySourceRowCount: 1,
      inventoryImportRowCount: 1,
      inventoryBoards: 4,
      inventoryMeters: 8,
      inventoryValue: 80,
      openingDebitTotal: 1080,
      openingCreditTotal: 1080,
      openingGap: 0,
      journalMustPost: true,
      fullTrialBalanceRequired: true,
    },
    customerRows: [
      {
        entity: "CUSTOMER", decisionId: "SYN-C1", sourceFileId: "synthetic.xlsx",
        sourceSheetOrPage: "s1", sourceRow: 2, sourceKey: `syn/${tag}/cust/1`,
        normalizedApprovedKey: `SYN DEBIT ${tag}`, approvalStatus: "APPROVED",
        approvedName: "Synthetic Debit Customer", approvedCode: `D${tag}`.slice(0, 20),
        side: "DEBIT", sourceAmount: 1000, approvedAmount: 1000,
      },
      {
        entity: "CUSTOMER", decisionId: "SYN-C2", sourceFileId: "synthetic.xlsx",
        sourceSheetOrPage: "s1", sourceRow: 3, sourceKey: `syn/${tag}/cust/2`,
        normalizedApprovedKey: `SYN CREDIT ${tag}`, approvalStatus: "APPROVED",
        approvedName: "Synthetic Credit Customer", approvedCode: `C${tag}`.slice(0, 20),
        side: "CREDIT", sourceAmount: 400, approvedAmount: 400,
      },
    ],
    productRows: [
      {
        entity: "PRODUCT", decisionId: "SYN-P1", sourceFileId: "synthetic.pdf",
        sourceSheetOrPage: "1", sourceRow: 1, sourceKey: `syn/${tag}/prod/1`,
        normalizedApprovedKey: `P${tag}|2`, approvalStatus: "APPROVED",
        approvedCode: `P${tag}`, sourceDescriptiveName: "Synthetic Board",
        approvedColorAr: "لون تجريبي", approvedColorEn: "Synthetic Colour",
        approvedCategory: "NORMAL", sizeMetersPerBoard: 2,
        defaultSalePricePerMeter: 12, defaultPurchasePricePerMeter: 10,
      },
    ],
    inventoryRows: [
      {
        entity: "INVENTORY", decisionId: "SYN-I1", sourceFileId: "synthetic.pdf",
        sourceSheetOrPage: "1", sourceRow: 1, sourceKey: `syn/${tag}/inv/1`,
        normalizedApprovedKey: `P${tag}|2`, approvalStatus: "APPROVED",
        approvedCode: `P${tag}`, sizeMetersPerBoard: 2, boards: 4,
        canonicalMeters: 8, pricePerMeter: 10, rowValue: 80,
        zeroQuantityTreatment: "IMPORT_ZERO_QUANTITY_VARIANT",
      },
    ],
    openingGlRows: [
      {
        entity: "GL", decisionId: "SYN-G1", sourceFileId: "synthetic.xlsx",
        sourceSheetOrPage: "gl", sourceRow: 1, sourceKey: `syn/${tag}/gl/1`,
        normalizedApprovedKey: "EQUITY", approvalStatus: "APPROVED",
        accountCode: eqAccountCode, debit: 0, credit: 680,
      },
    ],
    excludedRows: [],
    acceptedWarnings: [],
    notes: "",
    ...over,
  };
  return cutoverManifestSchema.parse(base);
}

function runOptions(manifest: CutoverManifest, mode: "dry-run" | "execute") {
  return {
    mode,
    plan: planCutover(manifest),
    verifiedSourceHashes: { "synthetic.xlsx": "d".repeat(64) },
    codeRevision: "test",
  } as const;
}

beforeAll(async () => {
  app = await buildTestApp();
  service = app.app.get(CutoverService);
  statements = app.app.get(ConsolidatedStatementService);
  branchId = app.branchId;
  branchKey = (await app.prisma.branch.findUniqueOrThrow({ where: { id: branchId } })).nameAr;
  actorUserId = app.ownerId;
  actorPhone = app.ownerPhone;
  await app.prisma.userBranchAccess.upsert({
    where: { userId_branchId: { userId: actorUserId, branchId } },
    update: {},
    create: { userId: actorUserId, branchId },
  });

  const suffix = Date.now().toString(36);
  arAccountCode = `AR-${suffix}`;
  invAccountCode = `INV-${suffix}`;
  eqAccountCode = `EQ-${suffix}`;
  await leafAccount(arAccountCode, "ASSET", "CURRENT_ASSET", "AR_CONTROL");
  await leafAccount(invAccountCode, "ASSET", "CURRENT_ASSET");
  await leafAccount(eqAccountCode, "EQUITY", "EQUITY");

  await app.prisma.financialPeriod.upsert({
    where: { year_month: { year: 2026, month: 8 } },
    update: { status: "OPEN" },
    create: { year: 2026, month: 8, status: "OPEN" },
  });
}, 60_000);

afterAll(async () => {
  await teardownTestApp(app);
});

// ── Section 1 ────────────────────────────────────────────────────────────────

describe("Section 1 — fresh-database preparation", () => {
  it("targets only the exact codes the historical migrations seeded", () => {
    expect(SEEDED_CUSTOMER_CODES).toHaveLength(54);
    expect(SEEDED_CUSTOMER_CODES[0]).toBe("CST001");
    expect(SEEDED_CUSTOMER_CODES[53]).toBe("CST054");
    expect(SEEDED_SKU_CODE_PREFIX).toBe("AP ");
  });

  it("refuses to touch a database that already holds an operational document", async () => {
    // Give the schema an operational marker, then prove the guard stops.
    await app.prisma.cutoverImportBatch.create({
      data: {
        manifestId: "FRESHNESS-PROBE",
        manifestHash: "f".repeat(64),
        sourceHashes: {},
        mode: "DRY_RUN",
        scope: "AUDIT_ONLY",
        status: "COMPLETED",
        operator: "probe",
        approver: "probe",
        approvalDate: new Date("2026-08-01T00:00:00.000Z"),
        cutoverDate: new Date("2026-08-01T00:00:00.000Z"),
        branchId,
        importerVersion: "1.0.0",
      },
    });
    const before = await app.prisma.account.count();
    let refusal: unknown = null;
    try {
      // Not wrapped in $transaction: a rejection swallowed inside an interactive
      // transaction leaves the connection in an aborted state.
      await prepareFreshDatabase(app.prisma);
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toMatchObject({ code: CUTOVER_ERROR.DB_NOT_FRESH });
    // Nothing was deleted, and the chart of accounts is untouched.
    expect(await app.prisma.account.count()).toBe(before);
  });

  it("never deletes from the chart of accounts", () => {
    // The cleanup has no `account.delete*` call at all — system configuration
    // is preserved by construction, not by a conditional.
    const source = readFileSync(
      join(__dirname, "../../src/modules/cutover/fresh-db.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/account\.delete/);
  });
});

// ── Section 2 ────────────────────────────────────────────────────────────────

describe("Section 2 — branch and actor are bound, never guessed", () => {
  it("refuses an unknown branch id", async () => {
    const m = buildManifest(uniq(), {
      branch: {
        approvedBranchId: "00000000-0000-4000-8000-000000000000",
        approvedKey: branchKey,
        approvedNameAr: branchKey,
      },
    });
    await expect(service.run(runOptions(m, "execute"))).rejects.toMatchObject({
      code: CUTOVER_ERROR.BRANCH_MISSING,
    });
  });

  it("refuses when the branch key does not match the branch row", async () => {
    const m = buildManifest(uniq(), {
      branch: { approvedBranchId: branchId, approvedKey: "NOT-THE-BRANCH", approvedNameAr: "x" },
    });
    await expect(service.run(runOptions(m, "execute"))).rejects.toMatchObject({
      code: CUTOVER_ERROR.BRANCH_MISMATCH,
    });
  });

  it("refuses an unknown actor id", async () => {
    const m = buildManifest(uniq(), {
      actor: { approvedUserId: "00000000-0000-4000-8000-000000000001", approvedPhone: actorPhone },
    });
    await expect(service.run(runOptions(m, "execute"))).rejects.toMatchObject({
      code: CUTOVER_ERROR.ACTOR_MISSING,
    });
  });

  it("refuses when the actor's phone does not match the approved one", async () => {
    const m = buildManifest(uniq(), {
      actor: { approvedUserId: actorUserId, approvedPhone: "+201000000999" },
    });
    await expect(service.run(runOptions(m, "execute"))).rejects.toMatchObject({
      code: CUTOVER_ERROR.ACTOR_IDENTITY_MISMATCH,
    });
  });

  it("refuses an actor who is not an OWNER", async () => {
    const clerk = await app.prisma.user.create({
      data: {
        name: "Synthetic Clerk",
        phone: `+2015551${Math.floor(Math.random() * 90000) + 10000}`,
        passwordHash: "x",
        role: "ACCOUNTANT",
        status: "ACTIVE",
      },
    });
    await app.prisma.userBranchAccess.create({ data: { userId: clerk.id, branchId } });
    const m = buildManifest(uniq(), {
      actor: { approvedUserId: clerk.id, approvedPhone: clerk.phone },
    });
    await expect(service.run(runOptions(m, "execute"))).rejects.toMatchObject({
      code: CUTOVER_ERROR.ACTOR_NOT_OWNER,
    });
  });

  it("refuses an actor with no access to the approved branch", async () => {
    const owner = await app.prisma.user.create({
      data: {
        name: "Synthetic Other Owner",
        phone: `+2015552${Math.floor(Math.random() * 90000) + 10000}`,
        passwordHash: "x",
        role: "OWNER",
        status: "ACTIVE",
      },
    });
    const m = buildManifest(uniq(), {
      actor: { approvedUserId: owner.id, approvedPhone: owner.phone },
    });
    await expect(service.run(runOptions(m, "execute"))).rejects.toMatchObject({
      code: CUTOVER_ERROR.ACTOR_NOT_AUTHORIZED_FOR_BRANCH,
    });
  });

  it("records the manifest's real operator and approver, never a placeholder", async () => {
    const m = buildManifest(uniq());
    const result = await service.run(runOptions(m, "execute"));
    const batch = await app.prisma.cutoverImportBatch.findUnique({ where: { id: result.batchId! } });
    expect(batch?.operator).toBe("Synthetic Operator");
    expect(batch?.approver).toBe("Synthetic Approver");
    expect(batch?.operator).not.toBe("cli");
    expect(batch?.branchId).toBe(branchId);
    // The hashes stored are the ones actually verified this run.
    expect(batch?.sourceHashes).toEqual({ "synthetic.xlsx": "d".repeat(64) });
    expect(result.branchId).toBe(branchId);
    expect(result.actorUserId).toBe(actorUserId);
  });
});

// ── Sections 4 and 5 ─────────────────────────────────────────────────────────

describe("Sections 4 and 5 — opening balances really reach the ledger", () => {
  it("posts ONE balanced journal through PostingEngine and reconciles everything", async () => {
    const tag = uniq();
    const m = buildManifest(tag);
    const result = await service.run(runOptions(m, "execute"));

    expect(result.journalEntryId).toBeTruthy();

    const entry = await app.prisma.journalEntry.findUnique({
      where: { id: result.journalEntryId! },
      include: { lines: true },
    });
    expect(entry).toBeTruthy();
    expect(entry!.entryType).toBe("OPENING");
    // Posting date is the approved cutover date, not "today".
    expect(entry!.entryDate.toISOString().slice(0, 10)).toBe(CUTOVER);

    const dr = entry!.lines.reduce((a, l) => a + Number(l.debit), 0);
    const cr = entry!.lines.reduce((a, l) => a + Number(l.credit), 0);
    expect(dr).toBeCloseTo(1080, 2);
    expect(cr).toBeCloseTo(1080, 2);

    // Every AR line carries its own customer party dimension.
    const arAccount = await app.prisma.account.findUnique({ where: { code: arAccountCode } });
    const arLines = entry!.lines.filter((l) => l.accountId === arAccount!.id);
    expect(arLines).toHaveLength(2);
    for (const l of arLines) {
      expect(l.partyType).toBe("CUSTOMER");
      expect(l.partyId).toBeTruthy();
    }

    // Stock reconciles alongside the accounting.
    const balances = await app.prisma.branchInventoryBalance.findMany({ where: { branchId } });
    const stocked = balances.filter((b) => Number(b.boardsOnHand) > 0);
    expect(stocked.some((b) => Number(b.boardsOnHand) === 4 && Number(b.metersOnHand) === 8)).toBe(
      true,
    );

    // The journal is traceable from provenance.
    const journalRow = await app.prisma.cutoverImportRow.findFirst({
      where: { batchId: result.batchId!, entityType: "JOURNAL_ENTRY" },
    });
    expect(journalRow?.entityId).toBe(result.journalEntryId);
  });

  it("shows each customer's own opening balance on their statement", async () => {
    const tag = uniq();
    const m = buildManifest(tag);
    await service.run(runOptions(m, "execute"));

    const debitCustomer = await app.prisma.customer.findUnique({
      where: { code: `D${tag}`.slice(0, 20) },
    });
    const creditCustomer = await app.prisma.customer.findUnique({
      where: { code: `C${tag}`.slice(0, 20) },
    });
    expect(debitCustomer).toBeTruthy();
    expect(creditCustomer).toBeTruthy();

    // Read back through the normal statement service — not by counting rows.
    const debitStatement = await statements.build({
      category: "customers",
      entityId: debitCustomer!.id,
      to: "2026-12-31",
    });
    expect(Number(debitStatement.endingBalance)).toBeCloseTo(1000, 2);

    const creditStatement = await statements.build({
      category: "customers",
      entityId: creditCustomer!.id,
      to: "2026-12-31",
    });
    // A credit customer stays a CUSTOMER with a credit (negative) AR balance.
    expect(Number(creditStatement.endingBalance)).toBeCloseTo(-400, 2);

    // ...and is never turned into a supplier.
    const asSupplier = await app.prisma.supplier.findFirst({
      where: { nameAr: "Synthetic Credit Customer" },
    });
    expect(asSupplier).toBeNull();
  });

  it("refuses when an approved account code does not exist", async () => {
    const m = buildManifest(uniq(), {
      postingAccounts: { arControlCode: "NO-SUCH-AR", inventoryControlCode: invAccountCode },
    });
    await expect(service.run(runOptions(m, "execute"))).rejects.toMatchObject({
      code: CUTOVER_ERROR.ACCOUNT_MISSING,
    });
  });

  it("rolls back customers, products, stock AND the journal when posting fails", async () => {
    const tag = uniq();
    // An equity line that does not balance never reaches the engine — but an
    // account that exists yet is not postable does, so posting fails last.
    const groupAccount = await app.prisma.account.create({
      data: {
        code: `GRP-${tag}`,
        nameAr: "حساب تجميعي",
        nameEn: "Group account",
        category: "EQUITY",
        accountType: "EQUITY",
        isLeaf: false,
        active: true,
      },
    });
    const m = buildManifest(tag, {
      openingGlRows: [
        {
          entity: "GL", decisionId: "SYN-G1", sourceFileId: "synthetic.xlsx",
          sourceSheetOrPage: "gl", sourceRow: 1, sourceKey: `syn/${tag}/gl/1`,
          normalizedApprovedKey: "EQUITY", approvalStatus: "APPROVED",
          accountCode: groupAccount.code, debit: 0, credit: 680,
        },
      ] as never,
    });

    const before = await service.businessRowCounts();
    await expect(service.run(runOptions(m, "execute"))).rejects.toBeDefined();
    const after = await service.businessRowCounts();
    expect(after).toEqual(before);
  });

  it("dry-run performs the whole posting path and still leaves nothing behind", async () => {
    const before = await service.businessRowCounts();
    const result = await service.run(runOptions(buildManifest(uniq()), "dry-run"));
    expect(result.rolledBack).toBe(true);
    expect(result.journalEntryId).toBeTruthy();
    const after = await service.businessRowCounts();
    expect(after).toEqual(before);
  });
});

describe("period enforcement on the posting path", () => {
  it("refuses when the period for the cutover date does not exist", async () => {
    const m = buildManifest(uniq(), { cutoverDate: "2020-01-01" });
    await expect(service.run(runOptions(m, "execute"))).rejects.toMatchObject({
      code: CUTOVER_ERROR.PERIOD_MISSING,
    });
  });

  it("refuses when the period is CLOSED", async () => {
    await app.prisma.financialPeriod.upsert({
      where: { year_month: { year: 2021, month: 3 } },
      update: { status: "CLOSED" },
      create: { year: 2021, month: 3, status: "CLOSED" },
    });
    const m = buildManifest(uniq(), { cutoverDate: "2021-03-01" });
    await expect(service.run(runOptions(m, "execute"))).rejects.toMatchObject({
      code: CUTOVER_ERROR.PERIOD_CLOSED,
    });
  });
});
