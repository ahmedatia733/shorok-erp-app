/**
 * Cutover importer — planner, manifest gates and domain invariants.
 *
 * Every fixture here is SYNTHETIC. No real customer name, product code, price
 * or balance appears in this file or anywhere else in the repository.
 */

import { planCutover, computeManifestHash } from "../../src/modules/cutover/cutover-planner";
import { cutoverManifestSchema, type CutoverManifest } from "../../src/modules/cutover/manifest.schema";
import {
  assertCutoverDate,
  assertExecutePreconditions,
  assertOpeningScopeOnly,
  parseManifest,
} from "../../src/modules/cutover/manifest-loader";
import { CUTOVER_ERROR, CutoverRefusal } from "../../src/modules/cutover/cutover.types";
import { parseArgs, runManifestGates } from "../../src/modules/cutover/cutover.cli";

const CUTOVER = "2026-08-01";

function customer(over: Partial<Record<string, unknown>> = {}) {
  return {
    entity: "CUSTOMER",
    decisionId: "SYN-C1",
    sourceFileId: "synthetic.xlsx",
    sourceSheetOrPage: "sheet1",
    sourceRow: 2,
    sourceKey: "syn/cust/1",
    normalizedApprovedKey: "SYNTHETIC ALPHA",
    approvalStatus: "APPROVED",
    approvedName: "Synthetic Alpha",
    approvedCode: "SYN-001",
    side: "DEBIT",
    sourceAmount: 1000,
    approvedAmount: 1000,
    ...over,
  };
}

function product(over: Partial<Record<string, unknown>> = {}) {
  return {
    entity: "PRODUCT",
    decisionId: "SYN-P1",
    sourceFileId: "synthetic.pdf",
    sourceSheetOrPage: "1",
    sourceRow: 1,
    sourceKey: "syn/prod/1",
    normalizedApprovedKey: "SYN9|2",
    approvalStatus: "APPROVED",
    approvedCode: "SYN9",
    sourceDescriptiveName: "Synthetic Board",
    approvedColorAr: "لون تجريبي",
    approvedColorEn: "Synthetic Colour",
    approvedCategory: "NORMAL",
    sizeMetersPerBoard: 2,
    defaultSalePricePerMeter: 10,
    defaultPurchasePricePerMeter: 8,
    ...over,
  };
}

function stock(over: Partial<Record<string, unknown>> = {}) {
  return {
    entity: "INVENTORY",
    decisionId: "SYN-I1",
    sourceFileId: "synthetic.pdf",
    sourceSheetOrPage: "1",
    sourceRow: 1,
    sourceKey: "syn/inv/1",
    normalizedApprovedKey: "SYN9|2",
    approvalStatus: "APPROVED",
    approvedCode: "SYN9",
    sizeMetersPerBoard: 2,
    boards: 5,
    canonicalMeters: 10,
    pricePerMeter: 8,
    rowValue: 80,
    zeroQuantityTreatment: "IMPORT_ZERO_QUANTITY_VARIANT",
    ...over,
  };
}

function manifest(over: Partial<CutoverManifest> = {}): CutoverManifest {
  const base = {
    manifestVersion: 1,
    manifestId: "SYN-MANIFEST-1",
    cutoverDate: CUTOVER,
    importScope: "MASTER_AND_STOCK_ONLY",
    branch: {
      approvedBranchId: "11111111-1111-4111-8111-111111111111",
      approvedKey: "SYN-BRANCH",
      approvedNameAr: "فرع تجريبي",
    },
    actor: {
      approvedUserId: "22222222-2222-4222-8222-222222222222",
      approvedPhone: "+201555000001",
    },
    postingAccounts: { arControlCode: "SYN-AR", inventoryControlCode: "SYN-INV" },
    sourceFiles: [{ id: "synthetic.xlsx", sha256: "a".repeat(64) }],
    approvedManifestFiles: [],
    datePolicy: "SWAP_DAY_MONTH_ON_DATE_CELLS_V1",
    inventoryValueBasis: "PRINTED_PDF_TOTAL",
    reversalPolicyReference: "A_PLUS_D",
    balancingPolicy: "NO_JOURNAL",
    approver: "Synthetic Approver",
    approvalDate: "2026-08-01",
    operator: "Synthetic Operator",
    unresolvedDecisions: 0,
    expectedTotals: {
      customerDebitCount: 1,
      customerDebitTotal: 1000,
      customerCreditCount: 0,
      customerCreditTotal: 0,
      customerNetAr: 1000,
      inventorySourceRowCount: 1,
      inventoryImportRowCount: 1,
      inventoryBoards: 5,
      inventoryMeters: 10,
      inventoryValue: 80,
      openingDebitTotal: 1080,
      openingCreditTotal: 0,
      openingGap: 1080,
      journalMustPost: false,
      fullTrialBalanceRequired: false,
    },
    customerRows: [customer()],
    productRows: [product()],
    inventoryRows: [stock()],
    openingGlRows: [],
    excludedRows: [],
    acceptedWarnings: [],
    notes: "",
    ...over,
  };
  return cutoverManifestSchema.parse(base);
}

function expectRefusal(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CutoverRefusal);
    expect((e as CutoverRefusal).code).toBe(code);
    return;
  }
  throw new Error(`expected refusal ${code}, but nothing was thrown`);
}

describe("cutover manifest gates", () => {
  it("accepts a well-formed synthetic manifest", () => {
    const plan = planCutover(manifest());
    expect(plan.reconciliation.customerDebitTotal).toBe(1000);
    expect(plan.reconciliation.inventoryBoards).toBe(5);
    expect(plan.reconciliation.inventoryMeters).toBe(10);
  });

  it("refuses an unsupported manifest version", () => {
    expectRefusal(
      () => parseManifest(JSON.stringify({ manifestVersion: 2 })),
      CUTOVER_ERROR.MANIFEST_VERSION_UNSUPPORTED,
    );
  });

  it("refuses malformed JSON", () => {
    expectRefusal(() => parseManifest("{not json"), CUTOVER_ERROR.MANIFEST_INVALID);
  });

  it("refuses a cutover date other than the approved one", () => {
    expectRefusal(
      () => assertCutoverDate(manifest({ cutoverDate: "2026-09-01" }), CUTOVER),
      CUTOVER_ERROR.CUTOVER_DATE_MISMATCH,
    );
  });

  it("refuses a missing approver", () => {
    expectRefusal(() => planCutover(manifest({ approver: "" })), CUTOVER_ERROR.APPROVER_MISSING);
  });

  it("refuses a missing approval date", () => {
    expectRefusal(
      () => planCutover(manifest({ approvalDate: "" })),
      CUTOVER_ERROR.APPROVAL_DATE_MISSING,
    );
  });

  it("execute refuses when unresolved decisions remain", () => {
    expectRefusal(
      () => assertExecutePreconditions(manifest({ unresolvedDecisions: 3 }), "execute"),
      CUTOVER_ERROR.UNRESOLVED_DECISIONS,
    );
  });

  it("dry-run does not require unresolved decisions to be zero", () => {
    expect(() =>
      assertExecutePreconditions(manifest({ unresolvedDecisions: 3 }), "dry-run"),
    ).not.toThrow();
  });

  it("execute refuses a BLOCKED row", () => {
    expectRefusal(
      () =>
        assertExecutePreconditions(
          manifest({ customerRows: [customer({ approvalStatus: "BLOCKED" })] as never }),
          "execute",
        ),
      CUTOVER_ERROR.BLOCKED_ROW_MARKED_IMPORTABLE,
    );
  });

  it("refuses a row that is not APPROVED", () => {
    expectRefusal(
      () => planCutover(manifest({ customerRows: [customer({ approvalStatus: "REVIEW_REQUIRED" })] as never })),
      CUTOVER_ERROR.ROW_NOT_APPROVED,
    );
  });

  it("produces a stable manifest hash regardless of key order", () => {
    const a = computeManifestHash({ x: 1, y: [1, 2], z: { b: 2, a: 1 } });
    const b = computeManifestHash({ z: { a: 1, b: 2 }, y: [1, 2], x: 1 });
    expect(a).toBe(b);
  });
});

describe("opening scope is enforced", () => {
  it("refuses an operational sales invoice row", () => {
    expectRefusal(
      () =>
        assertOpeningScopeOnly(
          manifest({ customerRows: [customer({ sourceKey: "SALES_INVOICE/2026-08-05/1" })] as never }),
        ),
      CUTOVER_ERROR.OPERATIONAL_TRANSACTION_IN_MANIFEST,
    );
  });

  it("refuses an operational return row", () => {
    expectRefusal(
      () =>
        assertOpeningScopeOnly(
          manifest({ customerRows: [customer({ sourceKey: "SALES_RETURN/abc" })] as never }),
        ),
      CUTOVER_ERROR.OPERATIONAL_RETURN_IN_MANIFEST,
    );
  });

  it("refuses a pre-cutover (July) dated transaction row", () => {
    expectRefusal(
      () =>
        assertOpeningScopeOnly(
          manifest({ customerRows: [customer({ sourceKey: "row/2026-07-15/9" })] as never }),
        ),
      CUTOVER_ERROR.JULY_TRANSACTION_IN_MANIFEST,
    );
  });

  it("allows an opening row that carries the cutover date", () => {
    expect(() =>
      assertOpeningScopeOnly(
        manifest({ customerRows: [customer({ sourceKey: "opening/2026-08-01/2" })] as never }),
      ),
    ).not.toThrow();
  });
});

describe("uniqueness and identity", () => {
  it("refuses a duplicate source key", () => {
    expectRefusal(
      () =>
        planCutover(
          manifest({
            customerRows: [customer(), customer({ decisionId: "SYN-C2", approvedCode: "SYN-002" })] as never,
          }),
        ),
      CUTOVER_ERROR.DUPLICATE_SOURCE_KEY,
    );
  });

  it("refuses two customers that normalize to the same approved key", () => {
    expectRefusal(
      () =>
        planCutover(
          manifest({
            customerRows: [
              customer(),
              customer({ decisionId: "SYN-C2", sourceKey: "syn/cust/2", approvedCode: "SYN-002" }),
            ] as never,
            expectedTotals: { ...manifest().expectedTotals, customerDebitCount: 2, customerDebitTotal: 2000, customerNetAr: 2000 },
          }),
        ),
      CUTOVER_ERROR.DUPLICATE_CUSTOMER_KEY,
    );
  });

  it("refuses two variants with the same code and size", () => {
    expectRefusal(
      () =>
        planCutover(
          manifest({
            productRows: [product(), product({ decisionId: "SYN-P2", sourceKey: "syn/prod/2" })] as never,
          }),
        ),
      CUTOVER_ERROR.DUPLICATE_VARIANT_KEY,
    );
  });

  it("keeps a numeric-looking product code as a string", () => {
    const plan = planCutover(
      manifest({
        productRows: [product({ approvedCode: "0537" })] as never,
        inventoryRows: [stock({ approvedCode: "0537" })] as never,
      }),
    );
    expect(plan.variants[0].code).toBe("0537");
    expect(typeof plan.variants[0].code).toBe("string");
  });

  it("treats the same code with different sizes as distinct variants", () => {
    const plan = planCutover(
      manifest({
        productRows: [
          product(),
          product({ decisionId: "SYN-P2", sourceKey: "syn/prod/2", sizeMetersPerBoard: 4 }),
        ] as never,
      }),
    );
    expect(plan.variants).toHaveLength(2);
    expect(new Set(plan.variants.map((v) => v.approvedKey)).size).toBe(2);
  });
});

describe("inventory invariants", () => {
  it("refuses negative boards at BOTH layers", () => {
    // Layer 1: the schema rejects it outright.
    expect(() => manifest({ inventoryRows: [stock({ boards: -1, canonicalMeters: -2 })] as never })).toThrow();
    // Layer 2: were the schema bypassed, the planner still refuses.
    const bypassed = manifest();
    (bypassed.inventoryRows[0] as { boards: number }).boards = -1;
    expectRefusal(() => planCutover(bypassed), CUTOVER_ERROR.NEGATIVE_BOARDS);
  });

  it("refuses a zero or negative size at BOTH layers", () => {
    expect(() => manifest({ productRows: [product({ sizeMetersPerBoard: 0 })] as never })).toThrow();
    const bypassed = manifest();
    (bypassed.productRows[0] as { sizeMetersPerBoard: number }).sizeMetersPerBoard = 0;
    expectRefusal(() => planCutover(bypassed), CUTOVER_ERROR.INVALID_SIZE);
  });

  it("refuses declared meters that are not boards x size", () => {
    // 5 boards x 2 m = 10 m. Declaring the PDF's rounded 9 must be refused.
    expectRefusal(
      () => planCutover(manifest({ inventoryRows: [stock({ canonicalMeters: 9 })] as never })),
      CUTOVER_ERROR.METERS_INCONSISTENT,
    );
  });

  it("refuses inventory aggregates that disagree with the manifest", () => {
    expectRefusal(
      () =>
        planCutover(
          manifest({ expectedTotals: { ...manifest().expectedTotals, inventoryBoards: 99 } }),
        ),
      CUTOVER_ERROR.INVENTORY_TOTALS_MISMATCH,
    );
  });

  it("refuses customer aggregates that disagree with the manifest", () => {
    expectRefusal(
      () =>
        planCutover(
          manifest({ expectedTotals: { ...manifest().expectedTotals, customerDebitTotal: 999 } }),
        ),
      CUTOVER_ERROR.CUSTOMER_TOTALS_MISMATCH,
    );
  });

  it("imports a zero-quantity variant and flags it, without changing aggregates", () => {
    const plan = planCutover(
      manifest({
        productRows: [product(), product({ decisionId: "SYN-P2", sourceKey: "syn/prod/2", approvedCode: "SYNZ" })] as never,
        inventoryRows: [
          stock(),
          stock({
            decisionId: "SYN-I2",
            sourceKey: "syn/inv/2",
            approvedCode: "SYNZ",
            boards: 0,
            canonicalMeters: 0,
            pricePerMeter: 0,
            rowValue: 0,
          }),
        ] as never,
        expectedTotals: { ...manifest().expectedTotals, inventoryImportRowCount: 2 },
      }),
    );
    expect(plan.stock).toHaveLength(2);
    expect(plan.reconciliation.zeroQuantityVariants).toBe(1);
    // Aggregates are untouched by the zero row.
    expect(plan.reconciliation.inventoryBoards).toBe(5);
    expect(plan.reconciliation.inventoryMeters).toBe(10);
    expect(plan.warnings.some((w) => w.code === "ZERO_QUANTITY_VARIANT_IMPORTED")).toBe(true);
  });

  it("excludes a row marked EXCLUDE without counting it", () => {
    const plan = planCutover(
      manifest({
        inventoryRows: [
          stock(),
          stock({ decisionId: "SYN-I2", sourceKey: "syn/inv/2", zeroQuantityTreatment: "EXCLUDE" }),
        ] as never,
      }),
    );
    expect(plan.stock).toHaveLength(1);
  });
});

describe("colour policy", () => {
  it("refuses a whitespace-only Arabic colour (the column is NOT NULL in the schema)", () => {
    expectRefusal(
      () => planCutover(manifest({ productRows: [product({ approvedColorAr: " " })] as never })),
      CUTOVER_ERROR.COLOR_POLICY_VIOLATION,
    );
  });

  it("refuses an empty Arabic colour at the schema layer", () => {
    expect(() => manifest({ productRows: [product({ approvedColorAr: "" })] as never })).toThrow();
  });
});

describe("opening journal", () => {
  const withJournal = (glRows: unknown[], inventoryValue = 80) =>
    manifest({
      importScope: "FULL_OPENING_IMPORT",
      balancingPolicy: "REQUIRE_FULL_TRIAL_BALANCE",
      openingGlRows: glRows as never,
      expectedTotals: {
        ...manifest().expectedTotals,
        journalMustPost: true,
        fullTrialBalanceRequired: true,
        inventoryValue,
      },
    });

  const gl = (over: Record<string, unknown> = {}) => ({
    entity: "GL",
    decisionId: "SYN-G1",
    sourceFileId: "synthetic.xlsx",
    sourceSheetOrPage: "gl",
    sourceRow: 1,
    sourceKey: "syn/gl/1",
    normalizedApprovedKey: "EQUITY",
    approvalStatus: "APPROVED",
    accountCode: "EQUITY",
    debit: 0,
    credit: 1080,
    ...over,
  });

  it("refuses an unbalanced opening journal instead of inventing a suspense line", () => {
    expectRefusal(() => planCutover(withJournal([])), CUTOVER_ERROR.JOURNAL_UNBALANCED);
  });

  it("posts a balanced opening journal with AR party dimensions", () => {
    const plan = planCutover(withJournal([gl()]));
    expect(plan.journalMustPost).toBe(true);
    expect(plan.reconciliation.journalBalanced).toBe(true);
    const arLines = plan.journalLines.filter((l) => l.accountCode === "SYN-AR");
    expect(arLines).toHaveLength(1);
    expect(arLines[0].partyType).toBe("CUSTOMER");
    expect(arLines[0].partyRef).toBeTruthy();
  });

  it("keeps a credit customer on the credit side of AR, still as a customer", () => {
    const plan = planCutover(
      manifest({
        customerRows: [customer({ side: "CREDIT" })] as never,
        expectedTotals: {
          ...manifest().expectedTotals,
          customerDebitCount: 0,
          customerDebitTotal: 0,
          customerCreditCount: 1,
          customerCreditTotal: 1000,
          customerNetAr: -1000,
        },
      }),
    );
    expect(plan.customers[0].side).toBe("CREDIT");
    expect(plan.customers[0].amount).toBe(1000);
  });

  it("MASTER_AND_STOCK_ONLY never posts a journal", () => {
    const plan = planCutover(manifest());
    expect(plan.journalMustPost).toBe(false);
    expect(plan.journalLines).toHaveLength(0);
  });
});

describe("accepted source anomalies stay traceable", () => {
  it("carries an approved snapshot-date override through to the plan warnings", () => {
    const plan = planCutover(
      manifest({
        acceptedWarnings: [
          {
            code: "SOURCE_DATE_ANOMALY_ACCEPTED_AS_OPENING_SNAPSHOT",
            decisionId: "SYN-C1",
            note: "stored date resolves after cutover; posted at cutover date",
          },
        ],
      }),
    );
    const w = plan.warnings.find(
      (x) => x.code === "SOURCE_DATE_ANOMALY_ACCEPTED_AS_OPENING_SNAPSHOT",
    );
    expect(w).toBeDefined();
    expect(w?.decisionId).toBe("SYN-C1");
    // The override changes the posting date only; the source amount is untouched.
    expect(plan.customers[0].amount).toBe(1000);
    expect(plan.cutoverDate).toBe(CUTOVER);
  });
});

describe("CLI argument handling", () => {
  it("refuses when no mode is given", () => {
    expectRefusal(() => parseArgs(["--manifest", "/tmp/m.json"]), CUTOVER_ERROR.MODE_MISSING);
  });

  it("refuses when two modes are given", () => {
    expectRefusal(() => parseArgs(["--audit", "--execute"]), CUTOVER_ERROR.MODE_AMBIGUOUS);
  });

  it("refuses a request to dump private data", () => {
    expectRefusal(
      () => runManifestGates({ mode: "audit", verbose: true, dumpPrivate: true }),
      CUTOVER_ERROR.PRIVATE_DUMP_REQUESTED,
    );
  });

  it("refuses a missing manifest path", () => {
    expectRefusal(
      () => runManifestGates({ mode: "audit", verbose: false, dumpPrivate: false }),
      CUTOVER_ERROR.MANIFEST_MISSING,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C6 — production-readiness corrections
// ─────────────────────────────────────────────────────────────────────────────

describe("C6 — approved branch and actor are bound in the plan", () => {
  it("carries the approved branch id, actor id and phone through to the plan", () => {
    const plan = planCutover(manifest());
    expect(plan.approvedBranchId).toBe("11111111-1111-4111-8111-111111111111");
    expect(plan.approvedActorUserId).toBe("22222222-2222-4222-8222-222222222222");
    expect(plan.approvedActorPhone).toBe("+201555000001");
  });

  it("carries the real operator, approver and approval date — never a placeholder", () => {
    const plan = planCutover(manifest());
    expect(plan.operator).toBe("Synthetic Operator");
    expect(plan.approver).toBe("Synthetic Approver");
    expect(plan.approvalDate).toBe("2026-08-01");
    expect(plan.operator).not.toBe("cli");
    expect(plan.approver).not.toBe("cli");
  });

  it("refuses a manifest with no branch id at all", () => {
    expect(() =>
      manifest({ branch: { approvedKey: "X", approvedNameAr: "Y" } as never }),
    ).toThrow();
  });

  it("refuses a manifest with no actor block", () => {
    expect(() => manifest({ actor: undefined as never })).toThrow();
  });
});

describe("C6 — product name is the colour, and nothing is silently discarded", () => {
  it("never persists a separate product name — the colour is the name", () => {
    const plan = planCutover(manifest());
    const v = plan.variants[0];
    expect(v.colorAr).toBe("لون تجريبي");
    expect(v.colorEn).toBe("Synthetic Colour");
    // The descriptive text survives as evidence but is explicitly not a name.
    expect(v.sourceDescriptiveName).toBe("Synthetic Board");
    expect(Object.keys(v)).not.toContain("nameAr");
  });

  it("rejects an unknown `approvedName` key rather than ignoring it", () => {
    // The schema is strict, so an approver who fills the old field is told,
    // instead of having their value silently dropped.
    expect(() =>
      manifest({ productRows: [{ ...product(), approvedName: "X" }] as never }),
    ).toThrow();
  });
});

describe("C6 — opening journal policies", () => {
  const glLine = (over: Record<string, unknown> = {}) => ({
    entity: "GL",
    decisionId: "SYN-G1",
    sourceFileId: "synthetic.xlsx",
    sourceSheetOrPage: "gl",
    sourceRow: 1,
    sourceKey: "syn/gl/1",
    normalizedApprovedKey: "EQUITY",
    approvalStatus: "APPROVED",
    accountCode: "SYN-EQ",
    debit: 0,
    credit: 0,
    ...over,
  });

  const posting = (over: Partial<CutoverManifest> = {}) =>
    manifest({
      importScope: "FULL_OPENING_IMPORT",
      expectedTotals: { ...manifest().expectedTotals, journalMustPost: true },
      ...over,
    });

  it("refuses to post when the posting accounts are not declared", () => {
    expectRefusal(
      () =>
        planCutover(
          posting({
            balancingPolicy: "REQUIRE_FULL_TRIAL_BALANCE",
            postingAccounts: undefined,
            openingGlRows: [glLine({ credit: 1080 })] as never,
          }),
        ),
      CUTOVER_ERROR.POSTING_ACCOUNTS_NOT_DECLARED,
    );
  });

  it("REQUIRE_FULL_TRIAL_BALANCE refuses an unbalanced journal", () => {
    expectRefusal(
      () =>
        planCutover(
          posting({
            balancingPolicy: "REQUIRE_FULL_TRIAL_BALANCE",
            openingGlRows: [glLine({ credit: 1 })] as never,
          }),
        ),
      CUTOVER_ERROR.JOURNAL_UNBALANCED,
    );
  });

  it("NO_JOURNAL cannot be combined with a manifest that demands a journal", () => {
    expectRefusal(
      () => planCutover(posting({ balancingPolicy: "NO_JOURNAL" })),
      CUTOVER_ERROR.BALANCING_POLICY_NOT_PERMITTED,
    );
  });

  it("TEMPORARY_OPENING_EQUITY refuses when the equity block is not declared", () => {
    expectRefusal(
      () => planCutover(posting({ balancingPolicy: "TEMPORARY_OPENING_EQUITY" })),
      CUTOVER_ERROR.TEMPORARY_EQUITY_NOT_DECLARED,
    );
  });

  it("TEMPORARY_OPENING_EQUITY refuses an amount that does not actually balance", () => {
    expectRefusal(
      () =>
        planCutover(
          posting({
            balancingPolicy: "TEMPORARY_OPENING_EQUITY",
            temporaryOpeningEquity: {
              accountCode: "SYN-EQ",
              approvedAmount: 999,
              side: "CREDIT",
              approver: "Synthetic Approver",
              clearanceDeadline: "2026-12-31",
            },
          }),
        ),
      CUTOVER_ERROR.TEMPORARY_EQUITY_AMOUNT_MISMATCH,
    );
  });

  it("TEMPORARY_OPENING_EQUITY posts only the exact approved amount", () => {
    // Dr AR 1000 + Dr inventory 80 = 1080, so the approved credit must be 1080.
    const plan = planCutover(
      posting({
        balancingPolicy: "TEMPORARY_OPENING_EQUITY",
        temporaryOpeningEquity: {
          accountCode: "SYN-EQ",
          approvedAmount: 1080,
          side: "CREDIT",
          approver: "Synthetic Approver",
          clearanceDeadline: "2026-12-31",
        },
      }),
    );
    const eq = plan.journalLines.filter((l) => l.accountCode === "SYN-EQ");
    expect(eq).toHaveLength(1);
    expect(eq[0].credit).toBe(1080);
    expect(plan.reconciliation.journalBalanced).toBe(true);
    expect(plan.warnings.some((w) => w.code === "TEMPORARY_OPENING_EQUITY_USED")).toBe(true);
  });

  it("labels a MASTER_AND_STOCK_ONLY run as NOT_ACCOUNTING_COMPLETE", () => {
    const plan = planCutover(manifest());
    expect(plan.accountingComplete).toBe(false);
    expect(plan.warnings.some((w) => w.code === "NOT_ACCOUNTING_COMPLETE")).toBe(true);
  });

  it("marks a posting run as accounting-complete", () => {
    const plan = planCutover(
      posting({
        balancingPolicy: "REQUIRE_FULL_TRIAL_BALANCE",
        openingGlRows: [glLine({ credit: 1080 })] as never,
      }),
    );
    expect(plan.accountingComplete).toBe(true);
    expect(plan.warnings.some((w) => w.code === "NOT_ACCOUNTING_COMPLETE")).toBe(false);
  });

  it("gives every AR line its own customer party reference", () => {
    const plan = planCutover(
      posting({
        balancingPolicy: "REQUIRE_FULL_TRIAL_BALANCE",
        openingGlRows: [glLine({ credit: 1080 })] as never,
      }),
    );
    const ar = plan.journalLines.filter((l) => l.accountCode === "SYN-AR");
    expect(ar).toHaveLength(1);
    expect(ar[0].partyType).toBe("CUSTOMER");
    expect(ar[0].partyRef).toBe("SYNTHETIC ALPHA");
  });
});

describe("approved valuation rounding", () => {
  // Two stocked rows: 5 boards x 2m x 8 = 80, and 3 boards x 2m x 10 = 60.
  const twoRows = (over: Partial<CutoverManifest> = {}) =>
    manifest({
      productRows: [
        product(),
        product({ decisionId: "SYN-P2", sourceKey: "syn/prod/2", approvedCode: "SYN8" }),
      ] as never,
      inventoryRows: [
        stock(),
        stock({
          decisionId: "SYN-I2", sourceKey: "syn/inv/2", approvedCode: "SYN8",
          boards: 3, canonicalMeters: 6, pricePerMeter: 10, rowValue: 60,
        }),
      ] as never,
      expectedTotals: {
        ...manifest().expectedTotals,
        inventoryImportRowCount: 2, inventoryBoards: 8, inventoryMeters: 16,
        inventoryValue: 140,
      },
      ...over,
    });

  const adjustment = (amount: number) => ({
    amount,
    reason: "PRINTED_PDF_TOTAL_ROUNDING",
    approvedBy: "OTONOM — Business Owner",
    approvedAt: "2026-08-02",
  });

  it("applies the approved adjustment to the HIGHEST-value positive row only", () => {
    // 80 + 60 = 140; approved total 139.7 ⇒ adjustment −0.30.
    const plan = planCutover(
      twoRows({
        valuationRoundingAdjustment: adjustment(-0.3),
        expectedTotals: { ...twoRows().expectedTotals, inventoryValue: 139.7 },
      }),
    );
    const adjusted = plan.stock.filter((s) => s.valuationAdjustmentApplied !== 0);
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0].code).toBe("SYN9");        // the 80 row, not the 60 row
    expect(adjusted[0].sourceRowValue).toBe(80);
    expect(adjusted[0].valuationAdjustmentApplied).toBe(-0.3);
    expect(adjusted[0].rowValue).toBe(79.7);
    // The subledger now equals the approved total exactly.
    expect(plan.reconciliation.inventoryValue).toBe(139.7);
    // Quantities are untouched.
    expect(plan.reconciliation.inventoryBoards).toBe(8);
    expect(plan.reconciliation.inventoryMeters).toBe(16);
  });

  it("is deterministic and idempotent — same manifest, same row, same result", () => {
    const m = twoRows({
      valuationRoundingAdjustment: adjustment(-0.3),
      expectedTotals: { ...twoRows().expectedTotals, inventoryValue: 139.7 },
    });
    const a = planCutover(m);
    const b = planCutover(m);
    expect(a.stock.map((s) => [s.code, s.rowValue, s.valuationAdjustmentApplied]))
      .toEqual(b.stock.map((s) => [s.code, s.rowValue, s.valuationAdjustmentApplied]));
    expect(a.manifestHash).toBe(b.manifestHash);
  });

  it("refuses an adjustment that does not actually reconcile", () => {
    expectRefusal(
      () =>
        planCutover(
          twoRows({
            valuationRoundingAdjustment: adjustment(-0.5),
            expectedTotals: { ...twoRows().expectedTotals, inventoryValue: 139.7 },
          }),
        ),
      CUTOVER_ERROR.VALUATION_ADJUSTMENT_MISMATCH,
    );
  });

  it("refuses when there is no positive-quantity row to carry the adjustment", () => {
    expectRefusal(
      () =>
        planCutover(
          manifest({
            inventoryRows: [
              stock({ boards: 0, canonicalMeters: 0, pricePerMeter: 0, rowValue: 0 }),
            ] as never,
            valuationRoundingAdjustment: adjustment(-0.3),
            expectedTotals: {
              ...manifest().expectedTotals,
              inventoryBoards: 0, inventoryMeters: 0, inventoryValue: -0.3,
            },
          }),
        ),
      CUTOVER_ERROR.VALUATION_ADJUSTMENT_TARGET_MISSING,
    );
  });

  it("leaves every row untouched when no adjustment is declared", () => {
    const plan = planCutover(twoRows());
    expect(plan.stock.every((s) => s.valuationAdjustmentApplied === 0)).toBe(true);
    expect(plan.stock.every((s) => s.rowValue === s.sourceRowValue)).toBe(true);
  });
});

describe("master-only customers (legacy records with no approved replacement)", () => {
  const withMasterOnly = (over: Record<string, unknown> = {}) =>
    manifest({
      customerRows: [
        customer(),
        customer({
          decisionId: "LEG-1", sourceKey: "legacy/cust/1",
          normalizedApprovedKey: "LEGACY|L001", approvedCode: "L001",
          approvedAmount: 0, sourceAmount: 0,
          openingBalanceScope: "MASTER_ONLY", ...over,
        }),
      ] as never,
    });

  it("preserves them without changing the approved opening totals", () => {
    const plan = planCutover(withMasterOnly());
    expect(plan.customers).toHaveLength(2);
    expect(plan.reconciliation.masterOnlyCustomerCount).toBe(1);
    // The approved totals are untouched by preserving a customer.
    expect(plan.reconciliation.customerDebitCount).toBe(1);
    expect(plan.reconciliation.customerDebitTotal).toBe(1000);
    expect(plan.reconciliation.customerNetAr).toBe(1000);
  });

  it("refuses a master-only customer that carries a balance", () => {
    expectRefusal(
      () => planCutover(withMasterOnly({ approvedAmount: 500 })),
      CUTOVER_ERROR.MASTER_ONLY_CUSTOMER_HAS_BALANCE,
    );
  });

  it("gives a master-only customer no journal line", () => {
    const gl = {
      entity: "GL", decisionId: "SYN-G1", sourceFileId: "synthetic.xlsx",
      sourceSheetOrPage: "gl", sourceRow: 1, sourceKey: "syn/gl/1",
      normalizedApprovedKey: "EQUITY", approvalStatus: "APPROVED",
      accountCode: "SYN-EQ", debit: 0, credit: 1080,
    };
    const base = withMasterOnly();
    const plan = planCutover(
      manifest({
        customerRows: base.customerRows as never,
        importScope: "FULL_OPENING_IMPORT",
        balancingPolicy: "REQUIRE_FULL_TRIAL_BALANCE",
        openingGlRows: [gl] as never,
        expectedTotals: { ...manifest().expectedTotals, journalMustPost: true },
      }),
    );
    // Only the opening customer gets an AR line; the preserved one gets none.
    const ar = plan.journalLines.filter((l) => l.accountCode === "SYN-AR");
    expect(ar).toHaveLength(1);
    expect(ar[0].partyRef).toBe("SYNTHETIC ALPHA");
    expect(plan.reconciliation.journalBalanced).toBe(true);
  });
});
