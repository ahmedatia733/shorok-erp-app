/**
 * The preview fingerprint is what stops an approved comparison screen from
 * committing something else. It is only worth anything if it is (a) stable for
 * genuinely identical inputs and (b) sensitive to every input the calculation
 * depended on.
 */
import {
  canonicalJson,
  previewFingerprint,
  sha256Hex,
  snapshotFingerprint,
  type FingerprintInput,
} from "../../src/modules/invoice-revisions/revision-fingerprint";

const base: FingerprintInput = {
  invoiceKind: "SALES",
  invoiceId: "11111111-1111-1111-1111-111111111111",
  currentRevision: 1,
  beforeSnapshot: { header: { grandTotal: "20000.00" }, lines: [{ id: "a", boards: "10" }] },
  afterSnapshot: { header: { grandTotal: "18000.00" }, lines: [{ id: "a", boards: "9" }] },
  effects: { totalDelta: "-2000.00" },
  valuationState: [{ productVariantId: "v1", wac: "500.0000", meters: "40.0000" }],
  linkageState: { returns: [], allocations: [] },
  postingDate: "2026-08-04",
  actorId: "22222222-2222-2222-2222-222222222222",
};

describe("canonicalJson", () => {
  it("is independent of key order at every depth", () => {
    const a = { z: 1, a: { y: 2, b: 3 } };
    const b = { a: { b: 3, y: 2 }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("preserves array order, because order is meaningful for lines", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("treats an explicit undefined and an absent key as the same thing", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("serialises dates deterministically", () => {
    const iso = "2026-08-04T00:00:00.000Z";
    expect(canonicalJson({ d: new Date(iso) })).toBe(JSON.stringify({ d: iso }));
  });

  it("keeps null as null rather than dropping it", () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });
});

describe("previewFingerprint", () => {
  it("is a 64-character hex digest", () => {
    expect(previewFingerprint(base)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is stable across repeated calls with equal input", () => {
    expect(previewFingerprint(base)).toBe(previewFingerprint({ ...base }));
  });

  it("is stable when only the key order of a nested object changes", () => {
    const reordered: FingerprintInput = {
      ...base,
      beforeSnapshot: { lines: [{ boards: "10", id: "a" }], header: { grandTotal: "20000.00" } },
    };
    expect(previewFingerprint(reordered)).toBe(previewFingerprint(base));
  });

  // Every input the calculation depends on must be able to invalidate a preview.
  const mutations: Array<[string, Partial<FingerprintInput>]> = [
    ["the invoice's current revision", { currentRevision: 2 }],
    ["the invoice content before", { beforeSnapshot: { header: { grandTotal: "20001.00" } } }],
    ["the proposed content", { afterSnapshot: { header: { grandTotal: "18001.00" } } }],
    ["the calculated effects", { effects: { totalDelta: "-1999.00" } }],
    ["the stock and WAC behind the valuation", { valuationState: [{ productVariantId: "v1", wac: "499.0000", meters: "40.0000" }] }],
    ["a linked return", { linkageState: { returns: [{ id: "r1", status: "CONFIRMED" }], allocations: [] } }],
    ["a linked voucher allocation", { linkageState: { returns: [], allocations: [{ id: "a1", amount: "500.00" }] } }],
    ["the accounting posting date", { postingDate: "2026-09-01" }],
    ["the actor", { actorId: "33333333-3333-3333-3333-333333333333" }],
    ["the invoice", { invoiceId: "44444444-4444-4444-4444-444444444444" }],
    ["the document kind", { invoiceKind: "PURCHASE" }],
  ];
  it.each(mutations)("changes when %s changes", (_label, patch) => {
    expect(previewFingerprint({ ...base, ...patch })).not.toBe(previewFingerprint(base));
  });
});

describe("snapshotFingerprint", () => {
  it("matches a direct hash of the canonical form", () => {
    const snap = { header: { a: 1 }, lines: [] };
    expect(snapshotFingerprint(snap)).toBe(sha256Hex(canonicalJson(snap)));
  });

  it("differs for different content", () => {
    expect(snapshotFingerprint({ a: 1 })).not.toBe(snapshotFingerprint({ a: 2 }));
  });
});
