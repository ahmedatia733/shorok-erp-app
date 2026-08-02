/**
 * Cutover importer — database safety, redaction, date rules and return
 * classification. Synthetic data only.
 */

import {
  assertLocalTargetIsSafe,
  assertServerIdentityMatches,
  parseDatabaseUrl,
  LOCAL_DB_ALLOWLIST,
} from "../../src/modules/cutover/db-safety";
import { CUTOVER_ERROR, CutoverRefusal } from "../../src/modules/cutover/cutover.types";
import {
  bucketAmount,
  maskDatabaseUrl,
  maskIdentity,
  redact,
} from "../../src/modules/cutover/redaction";
import {
  applySnapshotDate,
  resolveDateCell,
  resolveTextDate,
} from "../../src/modules/cutover/source-date";
import {
  classifyReturnCandidate,
  hasReturnMarker,
} from "../../src/modules/cutover/return-classifier";

const CUTOVER = "2026-08-01";
const OK_URL = "postgresql://u:p@127.0.0.1:5432/shorok_erp_cutover_20260801_local";

async function expectRefusalAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  await expect(fn()).rejects.toMatchObject({ code });
}

describe("database safety", () => {
  it("refuses a missing database url", () => {
    expect(() => parseDatabaseUrl(undefined)).toThrow(CutoverRefusal);
    try {
      parseDatabaseUrl("");
    } catch (e) {
      expect((e as CutoverRefusal).code).toBe(CUTOVER_ERROR.DATABASE_URL_MISSING);
    }
  });

  it("refuses a malformed url", () => {
    try {
      parseDatabaseUrl("not-a-url");
    } catch (e) {
      expect((e as CutoverRefusal).code).toBe(CUTOVER_ERROR.DB_URL_MALFORMED);
    }
  });

  it("accepts an allowlisted loopback target", async () => {
    await expect(assertLocalTargetIsSafe(parseDatabaseUrl(OK_URL))).resolves.toBeUndefined();
  });

  it("refuses a managed/public host even when the database name is allowlisted", async () => {
    await expectRefusalAsync(
      () =>
        assertLocalTargetIsSafe(
          parseDatabaseUrl(
            "postgresql://u:p@containers-us-west-1.railway.app:5432/shorok_erp_cutover_20260801_local",
          ),
        ),
      CUTOVER_ERROR.DB_HOST_PUBLIC,
    );
  });

  it("refuses a non-loopback host", async () => {
    await expectRefusalAsync(
      () =>
        assertLocalTargetIsSafe(
          parseDatabaseUrl("postgresql://u:p@10.0.0.5:5432/shorok_erp_cutover_20260801_local"),
        ),
      CUTOVER_ERROR.DB_HOST_NOT_LOOPBACK,
    );
  });

  it("refuses the dev database outright, even on loopback", async () => {
    await expectRefusalAsync(
      () => assertLocalTargetIsSafe(parseDatabaseUrl("postgresql://u:p@127.0.0.1:5432/shorok_erp")),
      CUTOVER_ERROR.DB_TARGET_FORBIDDEN,
    );
  });

  it("refuses a database that merely contains 'test' but is not allowlisted", async () => {
    await expectRefusalAsync(
      () =>
        assertLocalTargetIsSafe(
          parseDatabaseUrl("postgresql://u:p@127.0.0.1:5432/some_other_test_db"),
        ),
      CUTOVER_ERROR.DB_NAME_NOT_ALLOWLISTED,
    );
    expect(LOCAL_DB_ALLOWLIST).not.toContain("some_other_test_db");
  });

  it("refuses when the live server reports a different database", async () => {
    await expectRefusalAsync(
      () =>
        assertServerIdentityMatches(parseDatabaseUrl(OK_URL), async () => [
          { db: "a_different_db", usr: "u", addr: "127.0.0.1", port: 5432, ver: "PostgreSQL 15" },
        ]),
      CUTOVER_ERROR.DB_IDENTITY_MISMATCH,
    );
  });

  it("refuses when the live server reports a non-loopback address", async () => {
    await expectRefusalAsync(
      () =>
        assertServerIdentityMatches(parseDatabaseUrl(OK_URL), async () => [
          {
            db: "shorok_erp_cutover_20260801_local",
            usr: "u",
            addr: "203.0.113.10",
            port: 5432,
            ver: "PostgreSQL 15",
          },
        ]),
      CUTOVER_ERROR.DB_HOST_NOT_LOOPBACK,
    );
  });

  it("accepts a matching loopback server identity", async () => {
    const identity = await assertServerIdentityMatches(parseDatabaseUrl(OK_URL), async () => [
      {
        db: "shorok_erp_cutover_20260801_local",
        usr: "u",
        addr: "127.0.0.1",
        port: 5432,
        ver: "PostgreSQL 15",
      },
    ]);
    expect(identity.currentDatabase).toBe("shorok_erp_cutover_20260801_local");
  });
});

describe("redaction", () => {
  it("never reveals a password or the full url", () => {
    const masked = maskDatabaseUrl("postgresql://someuser:sup3rs3cret@127.0.0.1:5432/db1");
    expect(masked).not.toContain("sup3rs3cret");
    expect(masked).toContain("***");
    expect(masked).toContain("db1");
  });

  it("masks an identity stably and irreversibly", () => {
    const a = maskIdentity("Synthetic Customer Alpha");
    expect(a).toBe(maskIdentity("Synthetic Customer Alpha"));
    expect(a).not.toContain("Synthetic");
    expect(a).toMatch(/^H[0-9a-f]{8}$/);
  });

  it("buckets an amount instead of printing it", () => {
    expect(bucketAmount(0)).toBe("0");
    expect(bucketAmount(950)).toBe("<1k");
    expect(bucketAmount(52_000)).toBe("10k-100k");
    expect(bucketAmount(-2_000_000)).toBe(">=1M");
  });

  it("redacts names and per-row balances from a nested object", () => {
    const out = redact({
      decisionId: "SYN-C1",
      count: 21,
      customerName: "Synthetic Customer Alpha",
      rows: [{ nameAr: "اسم تجريبي", amount: 416_000, code: "SYN-001" }],
    }) as Record<string, unknown>;

    expect(out.decisionId).toBe("SYN-C1");
    expect(out.count).toBe(21);
    expect(String(out.customerName)).toMatch(/^H[0-9a-f]{8}$/);
    const row = (out.rows as Array<Record<string, unknown>>)[0];
    expect(String(row.nameAr)).toMatch(/^H[0-9a-f]{8}$/);
    expect(row.amount).toBe("100k-1M");
    expect(row.code).toBe("SYN-001");
    expect(JSON.stringify(out)).not.toContain("Synthetic Customer Alpha");
    expect(JSON.stringify(out)).not.toContain("416000");
  });
});

describe("source date rules", () => {
  it("Rule A swaps day and month on a true date cell", () => {
    // Serial 46030 stores 2026-01-08; the true value is 1 August 2026.
    const r = resolveDateCell(46_030);
    expect(r.basis).toBe("DATE_CELL_SWAPPED");
    expect(r.iso).toBe("2026-08-01");
    expect(r.storedRepresentation).toBe("2026-01-08");
  });

  it("Rule B does NOT swap a text date", () => {
    const r = resolveTextDate("16/7/2026");
    expect(r.basis).toBe("TEXT_DMY_UNAMBIGUOUS");
    expect(r.iso).toBe("2026-07-16");
  });

  it("Rule B resolves an unambiguous m/d text date", () => {
    const r = resolveTextDate("7/16/2026");
    expect(r.basis).toBe("TEXT_MDY_UNAMBIGUOUS");
    expect(r.iso).toBe("2026-07-16");
  });

  it("Rule B blocks a genuinely ambiguous text date", () => {
    const r = resolveTextDate("5/6/2026");
    expect(r.basis).toBe("BLOCKED_DATE_AMBIGUOUS");
    expect(r.iso).toBeNull();
  });

  it("Rule B uses an explicit month label to break the tie", () => {
    const r = resolveTextDate("5/6/2026", "June");
    expect(r.basis).toBe("TEXT_RESOLVED_BY_MONTH_HINT");
    expect(r.iso).toBe("2026-06-05");
  });

  it("rejects an out-of-range serial rather than inventing a date", () => {
    expect(resolveDateCell(0).iso).toBeNull();
    expect(resolveDateCell(999_999).basis).toBe("BLOCKED_DATE_INVALID");
  });

  it("an approved snapshot override posts at the cutover date and keeps the evidence", () => {
    // Stored 2026-01-09 resolves to 2026-09-01 under Rule A — after cutover.
    const resolved = resolveDateCell(46_031);
    expect(resolved.iso).toBe("2026-09-01");

    const decision = applySnapshotDate(resolved, CUTOVER);
    expect(decision.postingDate).toBe(CUTOVER);
    expect(decision.anomaly).toBe(true);
    // The source evidence is preserved, never overwritten.
    expect(decision.resolvedIso).toBe("2026-09-01");
    expect(decision.storedRepresentation).toBe("2026-01-09");
  });

  it("a snapshot row already at the cutover date raises no anomaly", () => {
    const decision = applySnapshotDate(resolveDateCell(46_030), CUTOVER);
    expect(decision.anomaly).toBe(false);
    expect(decision.postingDate).toBe(CUTOVER);
  });
});

describe("return classification", () => {
  const base = { textCells: [], cutoverDate: CUTOVER, resolvedDate: "2026-07-20" };

  it("detects a negative-quantity sale row as a return candidate", () => {
    const r = classifyReturnCandidate({
      ...base,
      signalValues: { boards: -3, meters: -12, grossAmount: -6_720 },
    });
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain("negative_boards");
  });

  it("detects the Arabic return marker", () => {
    expect(hasReturnMarker("مرتجع بضاعة")).toBe(true);
    expect(hasReturnMarker("مردود مبيعات")).toBe(true);
    const r = classifyReturnCandidate({ ...base, signalValues: {}, textCells: ["مرتجع"] });
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain("arabic_return_marker");
  });

  it("does not match ordinary Arabic words that merely contain the letters", () => {
    expect(hasReturnMarker("وارد")).toBe(false);
    expect(hasReturnMarker("مورد رئيسي")).toBe(false);
    expect(hasReturnMarker("فردي")).toBe(false);
  });

  it("a STRUCTURAL negative alone is never a return", () => {
    // المتبقي = التحصيل − المطلوب and GP = المطلوب − التكلفة are negative on
    // 113 of 235 real rows; neither may create a return candidate.
    const r = classifyReturnCandidate({
      ...base,
      signalValues: {},
      structuralValues: [-5_000, -1_200],
    });
    expect(r.isCandidate).toBe(false);
    expect(r.classification).toBe("NOT_A_RETURN");
    expect(r.structuralNegativeCount).toBe(2);
  });

  it("classifies a pre-cutover return as already reflected in the opening snapshot", () => {
    const r = classifyReturnCandidate({
      ...base,
      signalValues: { boards: -2 },
      resolvedDate: "2026-07-28",
    });
    expect(r.classification).toBe("PRE_CUTOVER_RETURN");
    expect(r.treatment).toBe("PRE_CUTOVER_ALREADY_REFLECTED_IN_OPENING");
  });

  it("a post-cutover return must become a SalesReturn document", () => {
    const r = classifyReturnCandidate({
      ...base,
      signalValues: { boards: -2 },
      resolvedDate: "2026-08-15",
    });
    expect(r.classification).toBe("CUTOVER_OR_POST_CUTOVER_RETURN");
    expect(r.treatment).toBe("IMPORT_AS_SALES_RETURN");
  });

  it("blocks a return whose date could not be resolved", () => {
    const r = classifyReturnCandidate({ ...base, signalValues: { boards: -2 }, resolvedDate: null });
    expect(r.classification).toBe("DATE_AMBIGUOUS_RETURN");
    expect(r.treatment).toBe("BLOCKED_PENDING_REVIEW");
  });
});
