/**
 * Cutover importer — real-database behaviour: audit writes nothing, dry-run
 * always rolls back, execute commits, and a repeated execute is refused.
 *
 * Fixtures are SYNTHETIC. No private customer, product, price or balance is
 * used anywhere in this file.
 */

import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";
import { CutoverService } from "../../src/modules/cutover/cutover.service";
import { planCutover } from "../../src/modules/cutover/cutover-planner";
import { cutoverManifestSchema, type CutoverManifest } from "../../src/modules/cutover/manifest.schema";
import { CUTOVER_ERROR, CutoverRefusal } from "../../src/modules/cutover/cutover.types";
import type { AuthenticatedUser } from "../../src/common/types/request-user";

const CUTOVER = "2026-08-01";

let app: TestApp;
let service: CutoverService;
let branchId: string;
let actor: AuthenticatedUser;

/** Unique per test so parallel fixtures never collide on a unique code. */
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

function buildManifest(tag: string, over: Partial<CutoverManifest> = {}): CutoverManifest {
  const base = {
    manifestVersion: 1,
    manifestId: `SYN-${tag}`,
    cutoverDate: CUTOVER,
    importScope: "MASTER_AND_STOCK_ONLY",
    branch: { approvedKey: "SYN-BRANCH", approvedNameAr: "فرع تجريبي" },
    sourceFiles: [{ id: "synthetic.xlsx", sha256: "b".repeat(64) }],
    approvedManifestFiles: [],
    datePolicy: "SWAP_DAY_MONTH_ON_DATE_CELLS_V1",
    inventoryValueBasis: "PRINTED_PDF_TOTAL",
    reversalPolicyReference: "A_PLUS_D",
    balancingPolicy: "NO_JOURNAL",
    suspenseAccountCode: "",
    approver: "Synthetic Approver",
    approvalDate: CUTOVER,
    operator: "Synthetic Operator",
    unresolvedDecisions: 0,
    expectedTotals: {
      customerDebitCount: 1,
      customerDebitTotal: 500,
      customerCreditCount: 1,
      customerCreditTotal: 200,
      customerNetAr: 300,
      inventorySourceRowCount: 2,
      inventoryImportRowCount: 2,
      inventoryBoards: 6,
      inventoryMeters: 12,
      inventoryValue: 120,
      openingDebitTotal: 620,
      openingCreditTotal: 200,
      openingGap: 420,
      journalMustPost: false,
      fullTrialBalanceRequired: false,
    },
    customerRows: [
      {
        entity: "CUSTOMER", decisionId: "SYN-C1", sourceFileId: "synthetic.xlsx",
        sourceSheetOrPage: "s1", sourceRow: 2, sourceKey: `syn/${tag}/cust/1`,
        normalizedApprovedKey: `SYN ALPHA ${tag}`, approvalStatus: "APPROVED",
        approvedName: "Synthetic Alpha", approvedCode: `A${tag}`.slice(0, 20),
        side: "DEBIT", sourceAmount: 500, approvedAmount: 500,
      },
      {
        entity: "CUSTOMER", decisionId: "SYN-C2", sourceFileId: "synthetic.xlsx",
        sourceSheetOrPage: "s1", sourceRow: 3, sourceKey: `syn/${tag}/cust/2`,
        normalizedApprovedKey: `SYN BETA ${tag}`, approvalStatus: "APPROVED",
        approvedName: "Synthetic Beta", approvedCode: `B${tag}`.slice(0, 20),
        side: "CREDIT", sourceAmount: 200, approvedAmount: 200,
      },
    ],
    productRows: [
      {
        entity: "PRODUCT", decisionId: "SYN-P1", sourceFileId: "synthetic.pdf",
        sourceSheetOrPage: "1", sourceRow: 1, sourceKey: `syn/${tag}/prod/1`,
        normalizedApprovedKey: `P${tag}|2`, approvalStatus: "APPROVED",
        approvedCode: `P${tag}`, approvedName: "Synthetic Board",
        approvedColorAr: "لون تجريبي", approvedColorEn: "Synthetic Colour",
        approvedCategory: "NORMAL", sizeMetersPerBoard: 2,
        defaultSalePricePerMeter: 12, defaultPurchasePricePerMeter: 10,
      },
      {
        entity: "PRODUCT", decisionId: "SYN-P2", sourceFileId: "synthetic.pdf",
        sourceSheetOrPage: "1", sourceRow: 2, sourceKey: `syn/${tag}/prod/2`,
        normalizedApprovedKey: `Z${tag}|3`, approvalStatus: "APPROVED",
        approvedCode: `Z${tag}`, approvedName: "Synthetic Zero Board",
        approvedColorAr: "غير محدد", approvedColorEn: "Unspecified",
        approvedCategory: "NORMAL", sizeMetersPerBoard: 3,
        defaultSalePricePerMeter: 0, defaultPurchasePricePerMeter: 0,
      },
    ],
    inventoryRows: [
      {
        entity: "INVENTORY", decisionId: "SYN-I1", sourceFileId: "synthetic.pdf",
        sourceSheetOrPage: "1", sourceRow: 1, sourceKey: `syn/${tag}/inv/1`,
        normalizedApprovedKey: `P${tag}|2`, approvalStatus: "APPROVED",
        approvedCode: `P${tag}`, sizeMetersPerBoard: 2, boards: 6,
        canonicalMeters: 12, pricePerMeter: 10, rowValue: 120,
        zeroQuantityTreatment: "IMPORT_ZERO_QUANTITY_VARIANT",
      },
      {
        // The zero-quantity case: master record only, no movement, no journal line.
        entity: "INVENTORY", decisionId: "SYN-I2", sourceFileId: "synthetic.pdf",
        sourceSheetOrPage: "1", sourceRow: 2, sourceKey: `syn/${tag}/inv/2`,
        normalizedApprovedKey: `Z${tag}|3`, approvalStatus: "APPROVED",
        approvedCode: `Z${tag}`, sizeMetersPerBoard: 3, boards: 0,
        canonicalMeters: 0, pricePerMeter: 0, rowValue: 0,
        zeroQuantityTreatment: "IMPORT_ZERO_QUANTITY_VARIANT",
      },
    ],
    openingGlRows: [],
    excludedRows: [],
    acceptedWarnings: [
      {
        code: "SOURCE_DATE_ANOMALY_ACCEPTED_AS_OPENING_SNAPSHOT",
        decisionId: "SYN-C1",
        note: "stored date resolves after cutover; posted at the cutover date",
      },
    ],
    notes: "",
    ...over,
  };
  return cutoverManifestSchema.parse(base);
}

function runOptions(manifest: CutoverManifest, mode: "dry-run" | "execute") {
  return {
    mode,
    plan: planCutover(manifest),
    branchId,
    actor,
    manifestSourceHashes: { "synthetic.xlsx": "b".repeat(64) },
    operator: manifest.operator,
    approver: manifest.approver,
    approvalDate: manifest.approvalDate,
    codeRevision: "test",
  } as const;
}

beforeAll(async () => {
  app = await buildTestApp();
  service = app.app.get(CutoverService);
  branchId = app.branchId;
  actor = {
    id: app.ownerId,
    name: "Cutover Operator",
    phone: app.ownerPhone,
    email: null,
    role: "OWNER",
    status: "ACTIVE",
    allowedBranches: [branchId],
  };
}, 60_000);

afterAll(async () => {
  await teardownTestApp(app);
});

describe("audit mode", () => {
  it("performs zero database writes", async () => {
    const before = await service.businessRowCounts();
    // Audit is exactly "plan and stop" — the planner touches no client at all.
    const plan = planCutover(buildManifest(uniq()));
    expect(plan.reconciliation.inventoryBoards).toBe(6);
    const after = await service.businessRowCounts();
    expect(after).toEqual(before);
  });
});

describe("dry-run", () => {
  it("performs the full import and then rolls everything back", async () => {
    const before = await service.businessRowCounts();
    const result = await service.run(runOptions(buildManifest(uniq()), "dry-run"));

    // It really did the work...
    expect(result.rolledBack).toBe(true);
    expect(result.createdCustomers).toBe(2);
    expect(result.createdVariants).toBe(2);
    expect(result.stockMovements).toBe(1);
    expect(result.zeroQuantitySkipped).toBe(1);

    // ...and left nothing behind. Sequence values may have advanced; business
    // rows are the proof, not sequence internals.
    const after = await service.businessRowCounts();
    expect(after).toEqual(before);
  });
});

describe("execute", () => {
  it("commits a valid synthetic manifest and records provenance", async () => {
    const tag = uniq();
    const manifest = buildManifest(tag);
    const before = await service.businessRowCounts();

    const result = await service.run(runOptions(manifest, "execute"));
    expect(result.rolledBack).toBe(false);
    expect(result.batchId).toBeTruthy();
    expect(result.createdCustomers).toBe(2);
    expect(result.createdSkus).toBe(2);
    expect(result.createdVariants).toBe(2);

    const after = await service.businessRowCounts();
    expect(after.customers).toBe(before.customers + 2);
    expect(after.variants).toBe(before.variants + 2);

    // One movement for the stocked row; the zero-quantity row creates none.
    expect(result.stockMovements).toBe(1);
    expect(result.zeroQuantitySkipped).toBe(1);

    const balances = await app.prisma.branchInventoryBalance.findMany({ where: { branchId } });
    const stocked = balances.filter((b) => Number(b.boardsOnHand) > 0);
    expect(stocked).toHaveLength(1);
    expect(Number(stocked[0].boardsOnHand)).toBe(6);
    // Canonical meters = boards x size, never the printed rounded column.
    expect(Number(stocked[0].metersOnHand)).toBe(12);

    // The zero-quantity variant exists as master data even with no stock.
    const zeroVariant = await app.prisma.productVariant.findFirst({
      where: { sku: { code: `Z${tag}` } },
    });
    expect(zeroVariant).toBeTruthy();
    expect(zeroVariant?.active).toBe(true);

    // Provenance covers every row, and records the zero-quantity decision.
    const rows = await app.prisma.cutoverImportRow.findMany({
      where: { batchId: result.batchId! },
    });
    expect(rows.length).toBe(6); // 2 customers + 2 variants + 2 stock rows
    expect(rows.filter((r) => r.action === "SKIPPED_ZERO_QTY")).toHaveLength(1);

    const batch = await app.prisma.cutoverImportBatch.findUnique({
      where: { id: result.batchId! },
    });
    expect(batch?.status).toBe("COMPLETED");
    expect(batch?.mode).toBe("EXECUTE");
    // The stored reconciliation must not carry a raw private figure.
    expect(JSON.stringify(batch?.reconciliation)).not.toContain("Synthetic Alpha");
  });

  it("refuses a second execute of the same manifest", async () => {
    const manifest = buildManifest(uniq());
    await service.run(runOptions(manifest, "execute"));

    const before = await service.businessRowCounts();
    await expect(service.run(runOptions(manifest, "execute"))).rejects.toMatchObject({
      code: CUTOVER_ERROR.DUPLICATE_BATCH,
    });
    // The refused re-run duplicated nothing.
    const after = await service.businessRowCounts();
    expect(after.customers).toBe(before.customers);
    expect(after.variants).toBe(before.variants);
  });

  it("keeps a credit customer as a CUSTOMER record", async () => {
    const tag = uniq();
    await service.run(runOptions(buildManifest(tag), "execute"));
    const credit = await app.prisma.customer.findUnique({ where: { code: `B${tag}`.slice(0, 20) } });
    expect(credit).toBeTruthy();
    const asSupplier = await app.prisma.supplier.findFirst({ where: { nameAr: "Synthetic Beta" } });
    expect(asSupplier).toBeNull();
  });

  it("rolls back customers, products and stock when a later step fails", async () => {
    const tag = uniq();
    // FULL_OPENING_IMPORT with no approved accounts fails at the journal step,
    // which is the LAST step — everything before it must be undone.
    const manifest = buildManifest(tag, {
      importScope: "FULL_OPENING_IMPORT",
      balancingPolicy: "REQUIRE_FULL_TRIAL_BALANCE",
      openingGlRows: [
        {
          entity: "GL", decisionId: "SYN-G1", sourceFileId: "synthetic.xlsx",
          sourceSheetOrPage: "gl", sourceRow: 1, sourceKey: `syn/${tag}/gl/1`,
          normalizedApprovedKey: "EQUITY", approvalStatus: "APPROVED",
          accountCode: "EQUITY", debit: 0, credit: 420,
        },
      ] as never,
      expectedTotals: {
        ...buildManifest(tag).expectedTotals,
        journalMustPost: true,
        fullTrialBalanceRequired: true,
      },
    });

    const before = await service.businessRowCounts();
    await expect(service.run(runOptions(manifest, "execute"))).rejects.toBeInstanceOf(
      CutoverRefusal,
    );
    const after = await service.businessRowCounts();
    expect(after).toEqual(before);
  });
});

describe("period enforcement", () => {
  it("refuses to post an opening journal when the period is missing", async () => {
    const tag = uniq();
    const manifest = buildManifest(tag, {
      cutoverDate: "2020-01-01",
      importScope: "FULL_OPENING_IMPORT",
      expectedTotals: { ...buildManifest(tag).expectedTotals, journalMustPost: true },
      openingGlRows: [
        {
          entity: "GL", decisionId: "SYN-G1", sourceFileId: "synthetic.xlsx",
          sourceSheetOrPage: "gl", sourceRow: 1, sourceKey: `syn/${tag}/gl/x`,
          normalizedApprovedKey: "EQUITY", approvalStatus: "APPROVED",
          accountCode: "EQUITY", debit: 0, credit: 420,
        },
      ] as never,
    });

    await expect(service.run(runOptions(manifest, "execute"))).rejects.toMatchObject({
      code: CUTOVER_ERROR.PERIOD_MISSING,
    });
  });

  it("refuses to post into a CLOSED period", async () => {
    await app.prisma.financialPeriod.upsert({
      where: { year_month: { year: 2021, month: 3 } },
      update: { status: "CLOSED" },
      create: { year: 2021, month: 3, status: "CLOSED" },
    });
    const tag = uniq();
    const manifest = buildManifest(tag, {
      cutoverDate: "2021-03-01",
      importScope: "FULL_OPENING_IMPORT",
      expectedTotals: { ...buildManifest(tag).expectedTotals, journalMustPost: true },
      openingGlRows: [
        {
          entity: "GL", decisionId: "SYN-G1", sourceFileId: "synthetic.xlsx",
          sourceSheetOrPage: "gl", sourceRow: 1, sourceKey: `syn/${tag}/gl/y`,
          normalizedApprovedKey: "EQUITY", approvalStatus: "APPROVED",
          accountCode: "EQUITY", debit: 0, credit: 420,
        },
      ] as never,
    });

    await expect(service.run(runOptions(manifest, "execute"))).rejects.toMatchObject({
      code: CUTOVER_ERROR.PERIOD_CLOSED,
    });
  });
});

describe("branch", () => {
  it("refuses an unknown branch", async () => {
    await expect(
      service.run({
        ...runOptions(buildManifest(uniq()), "execute"),
        branchId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toMatchObject({ code: CUTOVER_ERROR.BRANCH_MISSING });
  });
});
