import { describe, expect, it } from "@jest/globals";
import { movementDocument } from "./movement-document";

/**
 * An inventory movement records what produced it. These tests pin that the
 * mapping is structural — driven by the stored reference type — because the
 * two kinds of sales return live on different pages and confusing them is what
 * produced a "not found" link on the customer statement.
 */
describe("movementDocument", () => {
  const L = "ar";

  it("sends a legacy return to its OWN page, never the invoice-linked one", () => {
    const d = movementDocument({ referenceType: "legacy_sales_return", referenceId: "lr-1" }, L);
    expect(d).toEqual({ labelAr: "مردود بدون فاتورة", href: "/ar/sales/legacy-returns/lr-1" });
    expect(d!.href).not.toContain("/sales/returns/");
  });

  it("keeps an invoice-linked return on the ordinary return page", () => {
    expect(movementDocument({ referenceType: "sales_return", referenceId: "sr-1" }, L))
      .toEqual({ labelAr: "مردود فاتورة مبيعات", href: "/ar/sales/returns/sr-1" });
  });

  it("labels the reversal of a legacy return as a reversal, not a second original", () => {
    const d = movementDocument({ referenceType: "legacy_sales_return_cancel", referenceId: "lr-3" }, L);
    expect(d!.labelAr).toBe("إلغاء مردود بدون فاتورة");
    expect(d!.href).toBe("/ar/sales/legacy-returns/lr-3");
  });

  it("maps the invoice document kinds", () => {
    expect(movementDocument({ referenceType: "sales_invoice", referenceId: "i1" }, L)!.href).toBe("/ar/sales/invoices/i1");
    expect(movementDocument({ referenceType: "purchase_invoice", referenceId: "p1" }, L)!.href).toBe("/ar/purchasing/invoices/p1");
  });

  it("names documents that have no page of their own, without a dead link", () => {
    for (const t of ["CUTOVER_OPENING", "BRANCH_OPENING_INVENTORY"]) {
      const d = movementDocument({ referenceType: t, referenceId: "x" }, L);
      expect(d!.href).toBeNull();
      expect(d!.labelAr.length).toBeGreaterThan(0);
    }
  });

  it("a movement kind nobody has mapped yet still names itself rather than vanishing", () => {
    const d = movementDocument({ referenceType: "some_future_doc", referenceId: "x" }, L);
    expect(d).toEqual({ labelAr: "some_future_doc", href: null });
  });

  it("a movement with no reference renders as no document", () => {
    expect(movementDocument({ referenceType: null, referenceId: null }, L)).toBeNull();
    expect(movementDocument({}, L)).toBeNull();
  });

  it("never builds a link without an id", () => {
    expect(movementDocument({ referenceType: "legacy_sales_return", referenceId: null }, L))
      .toEqual({ labelAr: "مردود بدون فاتورة", href: null });
  });
  /**
   * Every reference type that exists in the live movement ledger, so a new
   * document kind cannot quietly render as an unlabelled row. The counts are
   * what production actually holds.
   */
  it("labels every reference type present in the live ledger", () => {
    const live = [
      "sales_invoice", "inventory_transfer", "purchase_invoice", "CUTOVER_OPENING",
      "BRANCH_OPENING_INVENTORY", "sales_invoice_revision_reversal", "purchase_invoice_revision",
      "purchase_invoice_revision_reversal", "sales_invoice_revision", "legacy_sales_return",
      "purchase_invoice_cancel", "sales_return", "sales_invoice_cancel", "legacy_sales_return_cancel",
    ];
    for (const type of live) {
      const doc = movementDocument({ referenceType: type, referenceId: "id-1" }, L);
      expect(doc).not.toBeNull();
      // an unmapped type falls back to echoing its raw key — none of these may
      expect(doc!.labelAr).not.toBe(type);
    }
  });

  it("links a transfer to the transfer page", () => {
    expect(movementDocument({ referenceType: "inventory_transfer", referenceId: "t-9" }, L))
      .toEqual({ labelAr: "تحويل مخزون", href: "/ar/inventory/transfers/t-9" });
  });

  it("labels an opening balance without inventing a page for it", () => {
    for (const type of ["CUTOVER_OPENING", "BRANCH_OPENING_INVENTORY"]) {
      // these carry a reference id in production, but no page exists to open
      expect(movementDocument({ referenceType: type, referenceId: "x" }, L)!.href).toBeNull();
    }
  });
  /**
   * A sale row used to read «فاتورة مبيعات», which is true of every sale and so
   * identifies none of them. The customer takes the headline; the invoice
   * number stays underneath; the link is untouched.
   */
  describe("a sale shows who it was to", () => {
    const sale = {
      invoiceNumber: "97",
      customerId: "cust-1",
      customerCode: "C-TEST",
      customerName: "عميل تجريبي",
    };

    it("headlines the customer instead of the generic label", () => {
      const d = movementDocument({ referenceType: "sales_invoice", referenceId: "inv-1", salesDocument: sale }, L);
      expect(d!.labelAr).toBe("عميل تجريبي");
      expect(d!.labelAr).not.toBe("فاتورة مبيعات");
    });

    it("keeps the invoice number available underneath", () => {
      const d = movementDocument({ referenceType: "sales_invoice", referenceId: "inv-1", salesDocument: sale }, L);
      expect(d!.subLabel).toBe("فاتورة 97");
    });

    it("keeps the very same link to the very same invoice", () => {
      const plain = movementDocument({ referenceType: "sales_invoice", referenceId: "inv-1" }, L);
      const named = movementDocument({ referenceType: "sales_invoice", referenceId: "inv-1", salesDocument: sale }, L);
      expect(named!.href).toBe(plain!.href);
      expect(named!.href).toBe("/ar/sales/invoices/inv-1");
    });

    it("says so when the movement is a cancellation or a revision", () => {
      // Otherwise the row would read as an ordinary sale to that customer.
      for (const [type, word] of [
        ["sales_invoice_cancel", "إلغاء فاتورة مبيعات"],
        ["sales_invoice_revision", "تعديل فاتورة مبيعات"],
        ["sales_invoice_revision_reversal", "عكس تعديل فاتورة مبيعات"],
      ] as const) {
        const d = movementDocument({ referenceType: type, referenceId: "inv-1", salesDocument: sale }, L);
        expect(d!.labelAr).toBe("عميل تجريبي");
        expect(d!.subLabel).toBe(`فاتورة 97 — ${word}`);
      }
    });

    it("uses English wording under the English locale", () => {
      const d = movementDocument({ referenceType: "sales_invoice", referenceId: "inv-1", salesDocument: sale }, "en");
      expect(d!.subLabel).toBe("Invoice 97");
      expect(d!.labelAr).toBe("عميل تجريبي"); // the stored name, unchanged
    });

    it("does not carry one row's customer into the next", () => {
      const a = movementDocument({ referenceType: "sales_invoice", referenceId: "inv-1", salesDocument: sale }, L);
      const b = movementDocument(
        { referenceType: "sales_invoice", referenceId: "inv-2", salesDocument: { ...sale, invoiceNumber: "98", customerName: "عميل آخر" } },
        L,
      );
      expect(a!.labelAr).toBe("عميل تجريبي");
      expect(b!.labelAr).toBe("عميل آخر");
    });

    it("falls back to the generic label when no customer resolved", () => {
      for (const missing of [null, undefined]) {
        const d = movementDocument({ referenceType: "sales_invoice", referenceId: "inv-1", salesDocument: missing }, L);
        expect(d!.labelAr).toBe("فاتورة مبيعات");
        expect(d!.subLabel).toBeUndefined();
        expect(d!.href).toBe("/ar/sales/invoices/inv-1");
      }
    });

    it("never renders an empty name as a heading", () => {
      const d = movementDocument(
        { referenceType: "sales_invoice", referenceId: "inv-1", salesDocument: { ...sale, customerName: "   " } },
        L,
      );
      expect(d!.labelAr).toBe("فاتورة مبيعات");
    });

    it("leaves every other document type exactly as it was", () => {
      for (const [type, label] of [
        ["purchase_invoice", "فاتورة مشتريات"],
        ["inventory_transfer", "تحويل مخزون"],
        ["legacy_sales_return", "مردود بدون فاتورة"],
        ["sales_return", "مردود فاتورة مبيعات"],
        ["purchase_return", "مردود مشتريات"],
        ["CUTOVER_OPENING", "رصيد افتتاحي"],
      ] as const) {
        // even if a stray salesDocument were attached, a non-sale keeps its label
        const d = movementDocument({ referenceType: type, referenceId: "x", salesDocument: sale }, L);
        expect(d!.labelAr).toBe(label);
        expect(d!.subLabel).toBeUndefined();
      }
    });
  });
});