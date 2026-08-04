/**
 * The revision badge is what tells an accountant, at a glance in the invoice
 * list, that the document in front of them is not the version that was first
 * confirmed. Getting "revision 1" wrong would badge every untouched invoice.
 */
import {
  newRevisionIdempotencyKey,
  revisionBadgeAr,
  revisionVersionLabelAr,
} from "./invoice-revisions-client";

describe("revisionBadgeAr", () => {
  it("shows nothing for an invoice that was never revised", () => {
    expect(revisionBadgeAr(1)).toBeNull();
  });

  it("treats a missing or nonsensical revision as never revised", () => {
    expect(revisionBadgeAr(0)).toBeNull();
    expect(revisionBadgeAr(-3)).toBeNull();
  });

  it("counts revisions, not versions", () => {
    // Version 2 means it has been revised ONCE.
    expect(revisionBadgeAr(2)).toBe("معدلة مرة");
    expect(revisionBadgeAr(3)).toBe("معدلة مرتين");
    expect(revisionBadgeAr(4)).toBe("معدلة 3 مرات");
    expect(revisionBadgeAr(11)).toBe("معدلة 10 مرات");
  });
});

describe("revisionVersionLabelAr", () => {
  it("names the version the invoice currently is", () => {
    expect(revisionVersionLabelAr(2)).toBe("تم التعديل — النسخة 2");
    expect(revisionVersionLabelAr(7)).toBe("تم التعديل — النسخة 7");
  });
});

describe("newRevisionIdempotencyKey", () => {
  const invoiceId = "11111111-2222-3333-4444-555555555555";

  it("matches the shape the API accepts", () => {
    // The server's schema is /^[A-Za-z0-9:_.-]+$/, 8..120 characters.
    const key = newRevisionIdempotencyKey(invoiceId);
    expect(key).toMatch(/^[A-Za-z0-9:_.-]+$/);
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(120);
  });

  it("carries the invoice it belongs to, so a stray key is traceable", () => {
    expect(newRevisionIdempotencyKey(invoiceId)).toContain(invoiceId.slice(0, 8));
  });

  it("is different every time it is called", () => {
    const keys = new Set(Array.from({ length: 50 }, () => newRevisionIdempotencyKey(invoiceId)));
    expect(keys.size).toBe(50);
  });
});
