import { Controller, Get, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../prisma/prisma.service";

const TaxLedgerQuerySchema = z.object({
  accountId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
type TaxLedgerQuery = z.infer<typeof TaxLedgerQuerySchema>;

const REF_TYPE_LABELS: Record<string, string> = {
  sales_invoice:    "فاتورة مبيعات",
  purchase_invoice: "فاتورة مشتريات",
  journal:          "قيد يومية",
  expense:          "مصروف",
};

// Reference types whose VAT belongs to the INPUT side (purchases/expenses) or
// the OUTPUT side (sales). A single VAT account can hold both, and reversals
// flip the debit/credit sign, so we classify by the transaction's ORIGIN — not
// by which side the line lands on. A cancellation reversal carries the original
// document's referenceType, so its (opposite-signed) VAT line nets against the
// original on the same side, driving the cancelled document to zero net VAT.
const INPUT_REF_TYPES  = new Set(["purchase_invoice", "purchase_return", "expense"]);
const OUTPUT_REF_TYPES = new Set(["sales_invoice", "sales_return"]);

type VatDirection = "input" | "output";

/**
 * Signed VAT contribution of one journal line, classified by transaction origin.
 * - input  (purchase/expense): amount = debit − credit  (original +, reversal −)
 * - output (sale):             amount = credit − debit   (original +, reversal −)
 * - manual/unknown: by the line's own side (debit → input, credit → output)
 */
function classifyVatLine(
  referenceType: string,
  debit: Decimal,
  credit: Decimal,
): { direction: VatDirection; amount: Decimal } {
  if (INPUT_REF_TYPES.has(referenceType))  return { direction: "input",  amount: debit.minus(credit) };
  if (OUTPUT_REF_TYPES.has(referenceType)) return { direction: "output", amount: credit.minus(debit) };
  // Manual journal / unknown source: fall back to the line's natural side.
  return debit.gte(credit)
    ? { direction: "input",  amount: debit.minus(credit) }
    : { direction: "output", amount: credit.minus(debit) };
}

@Controller("reports")
export class TaxLedgerController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /reports/tax-accounts
   * Returns all leaf accounts whose name contains tax-related keywords,
   * so the frontend can pre-fill the selector with the right accounts.
   */
  @Get("tax-accounts")
  @Roles("OWNER", "ACCOUNTANT")
  async taxAccounts() {
    const accounts = await this.prisma.account.findMany({
      where: {
        isLeaf: true,
        active: true,
        OR: [
          { nameAr: { contains: "ضريبة",  mode: "insensitive" } },
          { nameAr: { contains: "ضرائب",  mode: "insensitive" } },
          { nameAr: { contains: "vat",     mode: "insensitive" } },
          { nameAr: { contains: "موردون",  mode: "insensitive" } },
          { nameAr: { contains: "دائنون",  mode: "insensitive" } },
          { nameEn: { contains: "tax",     mode: "insensitive" } },
          { nameEn: { contains: "vat",     mode: "insensitive" } },
          { nameEn: { contains: "creditor", mode: "insensitive" } },
          { nameEn: { contains: "supplier", mode: "insensitive" } },
        ],
      },
      select: { id: true, code: true, nameAr: true, nameEn: true },
      orderBy: { code: "asc" },
    });
    return accounts;
  }

  /**
   * GET /reports/tax-ledger?accountId=&from=&to=
   * Returns a full tax account ledger:
   * - Opening balance (all movements before `from`)
   * - Period entries with running balance
   * - Closing balance
   * - Split totals: debit (input VAT) vs credit (output VAT)
   *
   * accountId is required; the frontend passes the chosen tax account.
   */
  @Get("tax-ledger")
  @Roles("OWNER", "ACCOUNTANT")
  async taxLedger(
    @Query(new ZodValidationPipe(TaxLedgerQuerySchema)) query: TaxLedgerQuery,
  ) {
    const fromDate = query.from ? new Date(query.from) : new Date("2000-01-01");
    const toDate   = query.to   ? new Date(query.to)   : new Date();
    toDate.setUTCHours(23, 59, 59, 999);

    // If no accountId, return all accounts matching tax keywords for display
    const accounts = await this.prisma.account.findMany({
      where: query.accountId
        ? { id: query.accountId }
        : {
            isLeaf: true,
            active: true,
            OR: [
              { nameAr: { contains: "ضريبة", mode: "insensitive" } },
              { nameAr: { contains: "ضرائب", mode: "insensitive" } },
              { nameEn: { contains: "tax",   mode: "insensitive" } },
              { nameEn: { contains: "vat",   mode: "insensitive" } },
            ],
          },
      select: { id: true, code: true, nameAr: true, nameEn: true },
    });

    const accountIds = accounts.map((a) => a.id);
    if (accountIds.length === 0) {
      return this.emptyResponse(query);
    }

    // Fetch all journal lines for these accounts
    const lines = await this.prisma.journalLine.findMany({
      where: { accountId: { in: accountIds } },
      include: {
        journalEntry: {
          select: {
            id: true,
            entryNumber: true,
            entryDate: true,
            reference: true,
            referenceType: true,
            referenceId: true,
            description: true,
            status: true,
            reversalOfId: true,
          },
        },
        account: { select: { id: true, code: true, nameAr: true } },
      },
      orderBy: [
        { journalEntry: { entryDate: "asc" } },
        { journalEntry: { entryNumber: "asc" } },
      ],
    });

    // ── Opening balance (all before fromDate) ─────────────────────────────
    let openingDebit     = new Decimal(0);
    let openingCredit    = new Decimal(0);
    let openingInputVat  = new Decimal(0);
    let openingOutputVat = new Decimal(0);
    const periodLines: typeof lines = [];

    for (const line of lines) {
      const d = line.journalEntry.entryDate;
      if (d < fromDate) {
        openingDebit  = openingDebit.plus(line.debit.toString());
        openingCredit = openingCredit.plus(line.credit.toString());
        const c = classifyVatLine(
          line.journalEntry.referenceType ?? "journal",
          new Decimal(line.debit.toString()),
          new Decimal(line.credit.toString()),
        );
        if (c.direction === "input") openingInputVat  = openingInputVat.plus(c.amount);
        else                         openingOutputVat = openingOutputVat.plus(c.amount);
      } else if (d <= toDate) {
        periodLines.push(line);
      }
    }

    // ── Build ledger rows with running balance ────────────────────────────
    // runningBalance: positive = net debit, negative = net credit
    let running = openingDebit.minus(openingCredit);

    const rawEntries = periodLines.map((line) => {
      const dr = new Decimal(line.debit.toString());
      const cr = new Decimal(line.credit.toString());
      running = running.plus(dr).minus(cr);

      const refType = line.journalEntry.referenceType ?? "journal";
      const isReversal = line.journalEntry.reversalOfId != null;
      const reversed   = line.journalEntry.status === "REVERSED";
      const vat = classifyVatLine(refType, dr, cr);
      return {
        id:            line.id,
        entryId:       line.journalEntry.id,
        entryNumber:   line.journalEntry.entryNumber.toString(),
        date:          line.journalEntry.entryDate.toISOString().slice(0, 10),
        reference:     line.journalEntry.reference ?? "",
        referenceType: refType,
        referenceLabel: REF_TYPE_LABELS[refType] ?? refType,
        referenceId:   line.journalEntry.referenceId ?? null,
        description:   line.journalEntry.description,
        note:          line.note ?? "",
        accountId:     line.account.id,
        accountCode:   line.account.code,
        accountNameAr: line.account.nameAr,
        debit:         dr.gt(0) ? dr.toFixed(2) : "",
        credit:        cr.gt(0) ? cr.toFixed(2) : "",
        runningBalance: running.toFixed(2),
        // VAT classification by transaction origin (nets reversals correctly).
        vatDirection:  vat.direction,
        vatAmount:     vat.amount.toFixed(2),
        isReversal,    // this line belongs to a reversal (cancellation) entry
        reversed,      // the entry this line belongs to has itself been reversed
      };
    });

    // ── Enrich with invoice details ───────────────────────────────────────
    const salesIds = [...new Set(
      rawEntries.filter(e => e.referenceType === "sales_invoice" && e.referenceId).map(e => e.referenceId!),
    )];
    const purchaseIds = [...new Set(
      rawEntries.filter(e => e.referenceType === "purchase_invoice" && e.referenceId).map(e => e.referenceId!),
    )];

    const [salesMap, purchaseMap] = await Promise.all([
      salesIds.length > 0
        ? this.prisma.salesInvoice.findMany({
            where: { id: { in: salesIds } },
            include: {
              customer: { select: { id: true, code: true, nameAr: true } },
              branch:   { select: { id: true, nameAr: true } },
            },
          }).then(invs => new Map(invs.map(i => [i.id, i] as [string, typeof i])))
        : Promise.resolve(new Map<string, any>()),
      purchaseIds.length > 0
        ? this.prisma.purchaseInvoice.findMany({
            where: { id: { in: purchaseIds } },
            include: {
              supplier: { select: { id: true, nameAr: true } },
              branch:   { select: { id: true, nameAr: true } },
            },
          }).then(invs => new Map(invs.map(i => [i.id, i] as [string, typeof i])))
        : Promise.resolve(new Map<string, any>()),
    ]);

    const entries = rawEntries.map(e => {
      let invoiceDetail: Record<string, any> | null = null;

      if (e.referenceType === "sales_invoice" && e.referenceId && salesMap.has(e.referenceId)) {
        const inv = salesMap.get(e.referenceId)!;
        invoiceDetail = {
          type:          "sales",
          invoiceNumber: inv.invoiceNumber.toString(),
          invoiceDate:   inv.invoiceDate.toISOString().slice(0, 10),
          entityLabel:   "العميل",
          entityNameAr:  inv.customer?.nameAr   ?? null,
          entityCode:    inv.customer?.code      ?? null,
          branchNameAr:  inv.branch?.nameAr      ?? null,
          subtotal:      inv.subtotal.toFixed(2),
          taxRate:       inv.taxRate.toFixed(2),
          taxAmount:     inv.taxAmount.toFixed(2),
          grandTotal:    inv.grandTotal.toFixed(2),
          totalCost:     inv.totalCost.toFixed(2),
          notes:         inv.notes ?? null,
        };
      } else if (e.referenceType === "purchase_invoice" && e.referenceId && purchaseMap.has(e.referenceId)) {
        const inv = purchaseMap.get(e.referenceId)!;
        invoiceDetail = {
          type:          "purchase",
          invoiceNumber: inv.invoiceNumber,
          invoiceDate:   inv.invoiceDate.toISOString().slice(0, 10),
          entityLabel:   "المورد",
          entityNameAr:  inv.supplier?.nameAr ?? null,
          entityCode:    null,
          branchNameAr:  inv.branch?.nameAr   ?? null,
          subtotal:      inv.subtotal.toFixed(2),
          taxRate:       null,
          taxAmount:     inv.taxAmount.toFixed(2),
          grandTotal:    inv.grandTotal.toFixed(2),
          totalCost:     null,
          notes:         inv.notes ?? null,
        };
      }

      return { ...e, invoiceDetail };
    });

    // ── Period totals ─────────────────────────────────────────────────────
    // Raw debit/credit are kept for the faithful GL ledger view; input/output
    // VAT are netted by transaction origin so reversals cancel their originals.
    let periodDebit     = new Decimal(0);
    let periodCredit    = new Decimal(0);
    let periodInputVat  = new Decimal(0);
    let periodOutputVat = new Decimal(0);
    for (const e of entries) {
      periodDebit  = periodDebit.plus(e.debit   || "0");
      periodCredit = periodCredit.plus(e.credit || "0");
      if (e.vatDirection === "input") periodInputVat  = periodInputVat.plus(e.vatAmount);
      else                            periodOutputVat = periodOutputVat.plus(e.vatAmount);
    }

    const closingDebit     = openingDebit.plus(periodDebit);
    const closingCredit    = openingCredit.plus(periodCredit);
    const closingInputVat  = openingInputVat.plus(periodInputVat);
    const closingOutputVat = openingOutputVat.plus(periodOutputVat);
    // Net VAT position by origin: output − input. Positive = liability (owe gov).
    const netPosition = closingOutputVat.minus(closingInputVat);

    return {
      from: query.from ?? null,
      to:   query.to   ?? null,
      accounts: accounts.map((a) => ({ id: a.id, code: a.code, nameAr: a.nameAr })),
      opening: {
        debit:     openingDebit.toFixed(2),
        credit:    openingCredit.toFixed(2),
        net:       openingDebit.minus(openingCredit).toFixed(2),
        inputVat:  openingInputVat.toFixed(2),
        outputVat: openingOutputVat.toFixed(2),
      },
      entries,
      periodTotals: {
        debit:     periodDebit.toFixed(2),
        credit:    periodCredit.toFixed(2),
        net:       periodDebit.minus(periodCredit).toFixed(2),
        inputVat:  periodInputVat.toFixed(2),
        outputVat: periodOutputVat.toFixed(2),
      },
      closing: {
        debit:     closingDebit.toFixed(2),
        credit:    closingCredit.toFixed(2),
        inputVat:  closingInputVat.toFixed(2),
        outputVat: closingOutputVat.toFixed(2),
        net:       netPosition.toFixed(2),
        // positive = liability (owe government), negative = receivable (gov owes you)
        status: netPosition.gt(0) ? "liability" : netPosition.lt(0) ? "receivable" : "zero",
      },
    };
  }

  private emptyResponse(query: TaxLedgerQuery) {
    const zero = "0.00";
    return {
      from: query.from ?? null,
      to:   query.to   ?? null,
      accounts: [],
      opening:      { debit: zero, credit: zero, net: zero, inputVat: zero, outputVat: zero },
      entries:      [],
      periodTotals: { debit: zero, credit: zero, net: zero, inputVat: zero, outputVat: zero },
      closing:      { debit: zero, credit: zero, net: zero, inputVat: zero, outputVat: zero, status: "zero" },
    };
  }
}
