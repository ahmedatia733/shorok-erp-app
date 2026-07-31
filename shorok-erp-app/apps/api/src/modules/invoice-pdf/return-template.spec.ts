import { buildReturnHtml } from "./return-template";
import { salesReturnToPdfData, purchaseReturnToPdfData } from "./return-pdf.mapper";

const salesLine = {
  returnedBoards: "1.0000",
  returnedMetersQuantity: "4.0000",
  originalSalePricePerMeter: "500.00",
  originalDiscountPct: "0.00",
  originalTaxRate: "14.00",
  returnSubtotal: "2000.00",
  returnDiscount: "0.00",
  returnNetExTax: "2000.00",
  returnTax: "280.00",
  returnTotal: "2280.00",
  returnCogs: "1200.00",
  lengthM: null,
  widthM: null,
  reason: null,
  note: null,
  productVariant: { sku: { code: "AP-100", colorNameAr: "أحمر" } },
};

const salesReturn = (status: string, extra: Record<string, unknown> = {}) => ({
  returnNumber: 7n,
  status,
  returnDate: new Date("2026-07-30"),
  subtotal: "2000.00",
  discountTotal: "0.00",
  taxTotal: "280.00",
  grandTotal: "2280.00",
  cogsReversalTotal: "1200.00",
  journalEntryId: status === "CONFIRMED" ? "je-1" : null,
  confirmedAt: status === "CONFIRMED" ? new Date("2026-07-30T10:00:00Z") : null,
  reason: "إرجاع عميل",
  notes: null,
  customer: { code: "C-0010", nameAr: "محمد الجردقه" },
  branch: { nameAr: "الفرع الرئيسي" },
  originalInvoice: { invoiceNumber: 6n, invoiceDate: new Date("2026-07-30") },
  confirmer: { name: "المالك" },
  lines: [salesLine],
  ...extra,
});

describe("buildReturnHtml (sales)", () => {
  it("a DRAFT sales return renders the explicit doc type, draft badge/watermark, party, number and totals (Arabic RTL)", () => {
    const html = buildReturnHtml(salesReturnToPdfData(salesReturn("DRAFT"), { locale: "ar", companyName: "شركة الشروق", journalEntryNumber: null }));
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("مردود فاتورة مبيعات — SR-7");
    expect(html).toContain("مسودة — غير مرحّل"); // status badge
    expect(html).toContain('class="watermark">مسودة');
    expect(html).toContain("محمد الجردقه"); // customer
    expect(html).toContain("SI-6"); // original invoice
    expect(html).toContain("إجمالي رصيد العميل"); // customer credit total
    expect(html).toContain("2280.00");
    expect(html).not.toContain("رصيد دائن للعميل");
  });

  it("a CONFIRMED sales return shows the confirmed badge, no draft watermark, and the journal number", () => {
    const html = buildReturnHtml(salesReturnToPdfData(salesReturn("CONFIRMED"), { locale: "ar", companyName: "شركة الشروق", journalEntryNumber: "1024" }));
    expect(html).toContain(">مؤكد<");
    expect(html).not.toContain('class="watermark">مسودة');
    expect(html).toContain("رقم القيد");
    expect(html).toContain("1024");
  });

  it("English renders LTR with the localized labels", () => {
    const html = buildReturnHtml(salesReturnToPdfData(salesReturn("DRAFT"), { locale: "en", companyName: "Shorok", journalEntryNumber: null }));
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("Sales Invoice Return — SR-7");
    expect(html).toContain("DRAFT — Not Posted");
    expect(html).toContain('class="watermark">DRAFT');
    expect(html).toContain("Customer credit total");
  });
});

describe("buildReturnHtml (purchase)", () => {
  const purchaseReturn = {
    returnNumber: 3n,
    status: "CONFIRMED",
    returnDate: new Date("2026-07-15"),
    subtotal: "1600.00",
    taxTotal: "224.00",
    grandTotal: "1824.00",
    inventoryValueOut: "1600.00",
    journalEntryId: "je-2",
    confirmedAt: new Date("2026-07-15T09:00:00Z"),
    reason: null,
    notes: null,
    supplier: { nameAr: "ميجا بوند" },
    branch: { nameAr: "الفرع الرئيسي" },
    originalInvoice: { invoiceNumber: 9n, invoiceDate: new Date("2026-07-01") },
    confirmer: { name: "المالك" },
    lines: [{
      returnedBoards: "1.0000", returnedMetersQuantity: "4.0000",
      originalPurchasePricePerMeter: "400.00", originalTaxRate: "14.00",
      returnNetExTax: "1600.00", returnTax: "224.00", returnTotal: "1824.00",
      lengthM: null, widthM: null, reason: null, note: null,
      productVariant: { sku: { code: "AP-200", colorNameAr: "أزرق" } },
    }],
  };

  it("renders the purchase doc type, supplier, inventory-out and supplier-debit total", () => {
    const html = buildReturnHtml(purchaseReturnToPdfData(purchaseReturn, { locale: "ar", companyName: "شركة الشروق", journalEntryNumber: "2048" }));
    expect(html).toContain("مردود فاتورة مشتريات — PR-3");
    expect(html).toContain("ميجا بوند");
    expect(html).toContain("قيمة المخزون الخارج");
    expect(html).toContain("إجمالي خصم المورد");
    expect(html).toContain("1824.00");
  });
});
