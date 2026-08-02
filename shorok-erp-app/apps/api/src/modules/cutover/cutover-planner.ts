import { createHash } from "node:crypto";
import {
  CUTOVER_ERROR,
  CUTOVER_WARNING,
  CutoverRefusal,
  type CutoverWarningCode,
} from "./cutover.types";
import type { CutoverManifest, CustomerRow, InventoryRow, ProductRow } from "./manifest.schema";

/**
 * The planner is PURE: manifest in, plan and reconciliation out. No database, no
 * filesystem, no clock. Audit mode is exactly "run the planner and stop", which
 * is what makes audit provably write-free.
 *
 * dry-run and execute both consume this same plan, so the two can never drift.
 */

const CENT = 100;
/** Money compares at 2dp; quantities at 4dp. Never a floating-point ===. */
const QTY_SCALE = 10_000;

function money(n: number): number {
  return Math.round(n * CENT) / CENT;
}
function qty(n: number): number {
  return Math.round(n * QTY_SCALE) / QTY_SCALE;
}
function sumMoney(values: number[]): number {
  return money(values.reduce((a, b) => a + b, 0));
}
function sumQty(values: number[]): number {
  return qty(values.reduce((a, b) => a + b, 0));
}

export interface PlannedCustomer {
  decisionId: string;
  sourceKey: string;
  approvedKey: string;
  code: string;
  nameAr: string;
  side: "DEBIT" | "CREDIT";
  amount: number;
}

export interface PlannedVariant {
  decisionId: string;
  sourceKey: string;
  approvedKey: string;
  code: string;
  /** Evidence only — the model has no product-name column. Never persisted. */
  sourceDescriptiveName: string;
  colorAr: string;
  colorEn: string;
  category: "NORMAL" | "SPECIAL";
  sizeMetersPerBoard: number;
  salePricePerMeter: number;
  purchasePricePerMeter: number;
}

export interface PlannedStock {
  decisionId: string;
  sourceKey: string;
  approvedKey: string;
  code: string;
  sizeMetersPerBoard: number;
  boards: number;
  canonicalMeters: number;
  pricePerMeter: number;
  rowValue: number;
  /** True when boards and meters are both zero: master data only, no movement. */
  zeroQuantity: boolean;
}

export interface PlannedJournalLine {
  accountCode: string;
  debit: number;
  credit: number;
  partyType?: "CUSTOMER";
  partyRef?: string;
}

export interface Reconciliation {
  customerDebitCount: number;
  customerDebitTotal: number;
  customerCreditCount: number;
  customerCreditTotal: number;
  customerNetAr: number;
  inventoryImportRowCount: number;
  inventoryBoards: number;
  inventoryMeters: number;
  inventoryValue: number;
  zeroQuantityVariants: number;
  openingDebitTotal: number;
  openingCreditTotal: number;
  openingGap: number;
  journalBalanced: boolean;
}

export interface CutoverPlan {
  manifestId: string;
  manifestHash: string;
  cutoverDate: string;
  scope: CutoverManifest["importScope"];
  branchKey: string;
  approvedBranchId: string;
  approvedActorUserId: string;
  approvedActorPhone: string;
  operator: string;
  approver: string;
  approvalDate: string;
  balancingPolicy: CutoverManifest["balancingPolicy"];
  arControlCode: string;
  inventoryControlCode: string;
  accountingComplete: boolean;
  customers: PlannedCustomer[];
  variants: PlannedVariant[];
  stock: PlannedStock[];
  journalLines: PlannedJournalLine[];
  reconciliation: Reconciliation;
  warnings: Array<{ code: CutoverWarningCode | string; decisionId: string; note: string }>;
  journalMustPost: boolean;
}

/** Canonical manifest hash: stable regardless of key order or whitespace. */
export function computeManifestHash(manifest: unknown): string {
  return createHash("sha256").update(stableStringify(manifest)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

function assertNoDuplicateSourceKeys(rows: Array<{ sourceKey: string; decisionId: string }>): void {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.sourceKey)) {
      throw new CutoverRefusal(CUTOVER_ERROR.DUPLICATE_SOURCE_KEY, { decisionId: r.decisionId });
    }
    seen.add(r.sourceKey);
  }
}

function assertImportable(
  row: { approvalStatus: string; decisionId: string },
  kind: string,
): void {
  if (row.approvalStatus === "BLOCKED") {
    throw new CutoverRefusal(CUTOVER_ERROR.BLOCKED_ROW_MARKED_IMPORTABLE, {
      decisionId: row.decisionId,
      kind,
    });
  }
  if (row.approvalStatus !== "APPROVED") {
    throw new CutoverRefusal(CUTOVER_ERROR.ROW_NOT_APPROVED, {
      decisionId: row.decisionId,
      kind,
      status: row.approvalStatus,
    });
  }
}

/**
 * Build the plan. Every refusal in here happens BEFORE any database work, so a
 * bad manifest never reaches an open transaction.
 */
export function planCutover(manifest: CutoverManifest): CutoverPlan {
  const warnings: CutoverPlan["warnings"] = [];
  const expected = manifest.expectedTotals;

  // ── manifest-level gates ────────────────────────────────────────────────
  if (!manifest.approver.trim()) throw new CutoverRefusal(CUTOVER_ERROR.APPROVER_MISSING);
  if (!manifest.approvalDate.trim()) throw new CutoverRefusal(CUTOVER_ERROR.APPROVAL_DATE_MISSING);

  const included = {
    customers: manifest.customerRows.filter((r) => r.approvalStatus !== "EXCLUDED"),
    products: manifest.productRows.filter((r) => r.approvalStatus !== "EXCLUDED"),
    inventory: manifest.inventoryRows.filter(
      (r) => r.approvalStatus !== "EXCLUDED" && r.zeroQuantityTreatment !== "EXCLUDE",
    ),
  };

  assertNoDuplicateSourceKeys([
    ...included.customers,
    ...included.products,
    ...included.inventory,
    ...manifest.openingGlRows,
  ]);

  // ── customers ───────────────────────────────────────────────────────────
  const customerKeys = new Set<string>();
  const customers: PlannedCustomer[] = included.customers.map((row: CustomerRow) => {
    assertImportable(row, "CUSTOMER");
    if (customerKeys.has(row.normalizedApprovedKey)) {
      throw new CutoverRefusal(CUTOVER_ERROR.DUPLICATE_CUSTOMER_KEY, { decisionId: row.decisionId });
    }
    customerKeys.add(row.normalizedApprovedKey);
    if (row.approvedCode.length > 20) {
      throw new CutoverRefusal(CUTOVER_ERROR.CUSTOMER_CODE_TOO_LONG, { decisionId: row.decisionId });
    }
    return {
      decisionId: row.decisionId,
      sourceKey: row.sourceKey,
      approvedKey: row.normalizedApprovedKey,
      code: row.approvedCode,
      nameAr: row.approvedName,
      side: row.side,
      amount: money(row.approvedAmount),
    };
  });

  // ── products ────────────────────────────────────────────────────────────
  const variantKeys = new Set<string>();
  const variants: PlannedVariant[] = included.products.map((row: ProductRow) => {
    assertImportable(row, "PRODUCT");
    if (row.sizeMetersPerBoard <= 0) {
      throw new CutoverRefusal(CUTOVER_ERROR.INVALID_SIZE, { decisionId: row.decisionId });
    }
    // The DB already enforces @@unique([skuId, sizeMetersPerBoard]); refusing
    // here turns a late constraint violation into an actionable message.
    const key = `${row.approvedCode}|${qty(row.sizeMetersPerBoard)}`;
    if (variantKeys.has(key)) {
      throw new CutoverRefusal(CUTOVER_ERROR.DUPLICATE_VARIANT_KEY, { decisionId: row.decisionId });
    }
    variantKeys.add(key);
    if (!row.approvedColorAr.trim() || !row.approvedColorEn.trim()) {
      throw new CutoverRefusal(CUTOVER_ERROR.COLOR_POLICY_VIOLATION, { decisionId: row.decisionId });
    }
    return {
      decisionId: row.decisionId,
      sourceKey: row.sourceKey,
      approvedKey: key,
      code: row.approvedCode,
      sourceDescriptiveName: row.sourceDescriptiveName,
      colorAr: row.approvedColorAr,
      colorEn: row.approvedColorEn,
      category: row.approvedCategory,
      sizeMetersPerBoard: qty(row.sizeMetersPerBoard),
      salePricePerMeter: money(row.defaultSalePricePerMeter),
      purchasePricePerMeter: money(row.defaultPurchasePricePerMeter),
    };
  });

  // ── inventory ───────────────────────────────────────────────────────────
  const stock: PlannedStock[] = included.inventory.map((row: InventoryRow) => {
    assertImportable(row, "INVENTORY");
    if (row.boards < 0) {
      throw new CutoverRefusal(CUTOVER_ERROR.NEGATIVE_BOARDS, { decisionId: row.decisionId });
    }
    if (row.sizeMetersPerBoard <= 0) {
      throw new CutoverRefusal(CUTOVER_ERROR.INVALID_SIZE, { decisionId: row.decisionId });
    }
    // Canonical meters are boards × size. The PDF's printed meters column is
    // display-rounded and is never accepted as a quantity.
    const canonical = qty(row.boards * row.sizeMetersPerBoard);
    if (canonical !== qty(row.canonicalMeters)) {
      throw new CutoverRefusal(CUTOVER_ERROR.METERS_INCONSISTENT, {
        decisionId: row.decisionId,
        expected: canonical,
        declared: qty(row.canonicalMeters),
      });
    }
    const zeroQuantity = row.boards === 0 && canonical === 0;
    if (zeroQuantity) {
      warnings.push({
        code: CUTOVER_WARNING.ZERO_QUANTITY_VARIANT_IMPORTED,
        decisionId: row.decisionId,
        note: "master record created; no inventory movement and no journal line",
      });
    }
    return {
      decisionId: row.decisionId,
      sourceKey: row.sourceKey,
      approvedKey: `${row.approvedCode}|${qty(row.sizeMetersPerBoard)}`,
      code: row.approvedCode,
      sizeMetersPerBoard: qty(row.sizeMetersPerBoard),
      boards: qty(row.boards),
      canonicalMeters: canonical,
      pricePerMeter: money(row.pricePerMeter),
      rowValue: money(row.rowValue),
      zeroQuantity,
    };
  });

  // ── reconciliation against the manifest's own approved expectations ──────
  const debit = customers.filter((c) => c.side === "DEBIT");
  const credit = customers.filter((c) => c.side === "CREDIT");
  const debitTotal = sumMoney(debit.map((c) => c.amount));
  const creditTotal = sumMoney(credit.map((c) => c.amount));
  const boards = sumQty(stock.map((s) => s.boards));
  const meters = sumQty(stock.map((s) => s.canonicalMeters));
  const inventoryValue = sumMoney(stock.map((s) => s.rowValue));

  if (
    debit.length !== expected.customerDebitCount ||
    credit.length !== expected.customerCreditCount ||
    debitTotal !== money(expected.customerDebitTotal) ||
    creditTotal !== money(expected.customerCreditTotal) ||
    money(debitTotal - creditTotal) !== money(expected.customerNetAr)
  ) {
    throw new CutoverRefusal(CUTOVER_ERROR.CUSTOMER_TOTALS_MISMATCH, {
      debitCount: debit.length,
      creditCount: credit.length,
      debitTotal,
      creditTotal,
    });
  }

  if (
    stock.length !== expected.inventoryImportRowCount ||
    boards !== qty(expected.inventoryBoards) ||
    meters !== qty(expected.inventoryMeters)
  ) {
    throw new CutoverRefusal(CUTOVER_ERROR.INVENTORY_TOTALS_MISMATCH, {
      rows: stock.length,
      boards,
      meters,
    });
  }

  // ── opening journal ─────────────────────────────────────────────────────
  const journalLines: PlannedJournalLine[] = [];
  const journalMustPost = expected.journalMustPost && manifest.importScope === "FULL_OPENING_IMPORT";

  if (journalMustPost) {
    if (!manifest.postingAccounts) {
      // The journal posts to real accounts resolved by code. Guessing which
      // account is "the AR control" is exactly the kind of silent choice this
      // importer must never make.
      throw new CutoverRefusal(CUTOVER_ERROR.POSTING_ACCOUNTS_NOT_DECLARED);
    }
    const arCode = manifest.postingAccounts.arControlCode;
    const invCode = manifest.postingAccounts.inventoryControlCode;

    // One AR line per customer, each carrying its own party dimension, so a
    // customer statement shows that customer's own opening balance rather than
    // one lump sum on the control account.
    for (const c of customers) {
      if (c.amount === 0) continue;
      journalLines.push({
        accountCode: arCode,
        debit: c.side === "DEBIT" ? c.amount : 0,
        credit: c.side === "CREDIT" ? c.amount : 0,
        partyType: "CUSTOMER",
        partyRef: c.approvedKey,
      });
    }

    const inventoryDebit = money(
      manifest.inventoryValueBasis === "PRINTED_PDF_TOTAL"
        ? expected.inventoryValue
        : inventoryValue,
    );
    if (inventoryDebit > 0) {
      journalLines.push({ accountCode: invCode, debit: inventoryDebit, credit: 0 });
    }
    for (const gl of manifest.openingGlRows) {
      journalLines.push({
        accountCode: gl.accountCode,
        debit: money(gl.debit),
        credit: money(gl.credit),
      });
    }

    let dr = sumMoney(journalLines.map((l) => l.debit));
    let cr = sumMoney(journalLines.map((l) => l.credit));

    switch (manifest.balancingPolicy) {
      case "REQUIRE_FULL_TRIAL_BALANCE":
        if (dr !== cr) {
          // No balancing line is ever invented to close the gap.
          throw new CutoverRefusal(CUTOVER_ERROR.JOURNAL_UNBALANCED, { debit: dr, credit: cr });
        }
        break;

      case "TEMPORARY_OPENING_EQUITY": {
        const eq = manifest.temporaryOpeningEquity;
        if (!eq) throw new CutoverRefusal(CUTOVER_ERROR.TEMPORARY_EQUITY_NOT_DECLARED);
        // The approver states the amount; the importer only VERIFIES that the
        // stated amount is the one that actually balances. It never computes it.
        const residual = money(dr - cr);
        const stated = money(eq.approvedAmount);
        const statedSigned = eq.side === "CREDIT" ? stated : -stated;
        if (residual !== statedSigned) {
          throw new CutoverRefusal(CUTOVER_ERROR.TEMPORARY_EQUITY_AMOUNT_MISMATCH, {
            residual,
            stated,
            side: eq.side,
          });
        }
        journalLines.push({
          accountCode: eq.accountCode,
          debit: eq.side === "DEBIT" ? stated : 0,
          credit: eq.side === "CREDIT" ? stated : 0,
        });
        warnings.push({
          code: CUTOVER_WARNING.TEMPORARY_OPENING_EQUITY_USED,
          decisionId: "MANIFEST",
          note: `temporary account ${eq.accountCode}, clearance by ${eq.clearanceDeadline}, approved by ${eq.approver}`,
        });
        dr = sumMoney(journalLines.map((l) => l.debit));
        cr = sumMoney(journalLines.map((l) => l.credit));
        if (dr !== cr) {
          throw new CutoverRefusal(CUTOVER_ERROR.JOURNAL_UNBALANCED, { debit: dr, credit: cr });
        }
        break;
      }

      case "NO_JOURNAL":
        // A manifest cannot both demand a journal and forbid one.
        throw new CutoverRefusal(CUTOVER_ERROR.BALANCING_POLICY_NOT_PERMITTED, {
          policy: manifest.balancingPolicy,
          reason: "journalMustPost_is_true",
        });
    }

    if (journalLines.some((l) => l.accountCode === arCode && !l.partyRef)) {
      throw new CutoverRefusal(CUTOVER_ERROR.AR_PARTY_DIMENSION_MISSING);
    }
  } else {
    // Master data and stock only. This is a legitimate scope, but it is NOT a
    // complete accounting cutover and the result says so.
    warnings.push({
      code: CUTOVER_WARNING.NOT_ACCOUNTING_COMPLETE,
      decisionId: "MANIFEST",
      note: "no opening journal posted; customer AR and inventory value are not in the ledger",
    });
  }

  const openingDebitTotal = sumMoney([
    ...journalLines.map((l) => l.debit),
    ...(journalMustPost ? [] : [debitTotal, money(expected.inventoryValue)]),
  ]);
  const openingCreditTotal = sumMoney([
    ...journalLines.map((l) => l.credit),
    ...(journalMustPost ? [] : [creditTotal]),
  ]);

  for (const w of manifest.acceptedWarnings) {
    warnings.push({ code: w.code, decisionId: w.decisionId, note: w.note });
  }

  return {
    manifestId: manifest.manifestId,
    manifestHash: computeManifestHash(manifest),
    cutoverDate: manifest.cutoverDate,
    scope: manifest.importScope,
    branchKey: manifest.branch.approvedKey,
    approvedBranchId: manifest.branch.approvedBranchId,
    approvedActorUserId: manifest.actor.approvedUserId,
    approvedActorPhone: manifest.actor.approvedPhone,
    operator: manifest.operator,
    approver: manifest.approver,
    approvalDate: manifest.approvalDate,
    balancingPolicy: manifest.balancingPolicy,
    arControlCode: manifest.postingAccounts?.arControlCode ?? "",
    inventoryControlCode: manifest.postingAccounts?.inventoryControlCode ?? "",
    accountingComplete: journalMustPost,
    customers,
    variants,
    stock,
    journalLines,
    journalMustPost,
    warnings,
    reconciliation: {
      customerDebitCount: debit.length,
      customerDebitTotal: debitTotal,
      customerCreditCount: credit.length,
      customerCreditTotal: creditTotal,
      customerNetAr: money(debitTotal - creditTotal),
      inventoryImportRowCount: stock.length,
      inventoryBoards: boards,
      inventoryMeters: meters,
      inventoryValue,
      zeroQuantityVariants: stock.filter((s) => s.zeroQuantity).length,
      openingDebitTotal,
      openingCreditTotal,
      openingGap: money(openingDebitTotal - openingCreditTotal),
      journalBalanced: !journalMustPost || openingDebitTotal === openingCreditTotal,
    },
  };
}
