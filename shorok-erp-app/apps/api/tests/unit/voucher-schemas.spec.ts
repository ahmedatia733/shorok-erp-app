/**
 * Phase 4B-1b — shared voucher Zod schema validation (pure, no DB).
 * Confirms the request contracts enforce their invariants before the API layer
 * is ever reached: positive amounts, no duplicate/over-allocation, strict
 * unknown-field rejection, non-empty updates, and date-range sanity.
 */
import {
  CreateReceiptVoucherSchema,
  UpdateReceiptVoucherSchema,
  ReceiptVoucherReverseSchema,
  ReceiptVoucherQuerySchema,
  ReceiptVoucherPostSchema,
} from "@shorok/shared";

const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const U3 = "33333333-3333-3333-3333-333333333333";
const INV_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const INV_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const baseCreate = {
  voucherDate: "2026-07-15",
  branchId: U1,
  customerId: U2,
  treasuryAccountId: U3,
  amount: "1000.00",
};

describe("CreateReceiptVoucherSchema", () => {
  it("accepts a minimal valid draft", () => {
    expect(CreateReceiptVoucherSchema.safeParse(baseCreate).success).toBe(true);
  });

  it("accepts allocations whose total equals the amount", () => {
    const r = CreateReceiptVoucherSchema.safeParse({
      ...baseCreate,
      allocations: [{ salesInvoiceId: INV_A, amount: "600.00" }, { salesInvoiceId: INV_B, amount: "400.00" }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects amount = 0", () => {
    expect(CreateReceiptVoucherSchema.safeParse({ ...baseCreate, amount: "0" }).success).toBe(false);
  });

  it("rejects negative amount", () => {
    expect(CreateReceiptVoucherSchema.safeParse({ ...baseCreate, amount: "-5.00" }).success).toBe(false);
  });

  it("rejects amount with > 2 decimals", () => {
    expect(CreateReceiptVoucherSchema.safeParse({ ...baseCreate, amount: "10.123" }).success).toBe(false);
  });

  it("rejects an allocation amount of 0", () => {
    const r = CreateReceiptVoucherSchema.safeParse({ ...baseCreate, allocations: [{ salesInvoiceId: INV_A, amount: "0" }] });
    expect(r.success).toBe(false);
  });

  it("rejects duplicate salesInvoiceId in allocations", () => {
    const r = CreateReceiptVoucherSchema.safeParse({
      ...baseCreate,
      allocations: [{ salesInvoiceId: INV_A, amount: "100.00" }, { salesInvoiceId: INV_A, amount: "100.00" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects allocations total exceeding the voucher amount", () => {
    const r = CreateReceiptVoucherSchema.safeParse({
      ...baseCreate,
      amount: "500.00",
      allocations: [{ salesInvoiceId: INV_A, amount: "300.00" }, { salesInvoiceId: INV_B, amount: "300.00" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(CreateReceiptVoucherSchema.safeParse({ ...baseCreate, status: "POSTED" }).success).toBe(false);
    expect(CreateReceiptVoucherSchema.safeParse({ ...baseCreate, journalEntryId: U1 }).success).toBe(false);
  });

  it("rejects a non-uuid customerId", () => {
    expect(CreateReceiptVoucherSchema.safeParse({ ...baseCreate, customerId: "nope" }).success).toBe(false);
  });
});

describe("UpdateReceiptVoucherSchema", () => {
  it("accepts a single-field update", () => {
    expect(UpdateReceiptVoucherSchema.safeParse({ amount: "50.00" }).success).toBe(true);
  });

  it("rejects an empty update", () => {
    expect(UpdateReceiptVoucherSchema.safeParse({}).success).toBe(false);
  });

  it("rejects status / journal / posting metadata (strict)", () => {
    expect(UpdateReceiptVoucherSchema.safeParse({ status: "POSTED" }).success).toBe(false);
    expect(UpdateReceiptVoucherSchema.safeParse({ journalEntryId: U1 }).success).toBe(false);
    expect(UpdateReceiptVoucherSchema.safeParse({ postedBy: U1 }).success).toBe(false);
  });

  it("rejects allocations over amount when both provided", () => {
    const r = UpdateReceiptVoucherSchema.safeParse({ amount: "100.00", allocations: [{ salesInvoiceId: INV_A, amount: "150.00" }] });
    expect(r.success).toBe(false);
  });

  it("allows reference/memo to be nulled", () => {
    expect(UpdateReceiptVoucherSchema.safeParse({ reference: null, memo: null }).success).toBe(true);
  });
});

describe("ReceiptVoucherReverseSchema", () => {
  it("requires a reason of at least 3 chars", () => {
    expect(ReceiptVoucherReverseSchema.safeParse({ reason: "خطأ في التسجيل" }).success).toBe(true);
    expect(ReceiptVoucherReverseSchema.safeParse({ reason: "x" }).success).toBe(false);
    expect(ReceiptVoucherReverseSchema.safeParse({}).success).toBe(false);
  });

  it("accepts an optional reversalDate", () => {
    expect(ReceiptVoucherReverseSchema.safeParse({ reason: "cancel", reversalDate: "2026-07-20" }).success).toBe(true);
  });
});

describe("ReceiptVoucherQuerySchema", () => {
  it("defaults limit to 20", () => {
    const r = ReceiptVoucherQuerySchema.parse({});
    expect(r.limit).toBe(20);
  });

  it("rejects dateFrom after dateTo", () => {
    expect(ReceiptVoucherQuerySchema.safeParse({ dateFrom: "2026-07-20", dateTo: "2026-07-10" }).success).toBe(false);
  });

  it("coerces a numeric limit string", () => {
    expect(ReceiptVoucherQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });
});

describe("ReceiptVoucherPostSchema", () => {
  it("accepts an empty body", () => {
    expect(ReceiptVoucherPostSchema.safeParse({}).success).toBe(true);
  });
  it("rejects extra fields (strict)", () => {
    expect(ReceiptVoucherPostSchema.safeParse({ idempotencyKey: "x" }).success).toBe(false);
  });
});
