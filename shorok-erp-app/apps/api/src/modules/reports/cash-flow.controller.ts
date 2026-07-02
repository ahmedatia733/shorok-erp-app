import { Controller, Get, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { CashFlowQuerySchema, type CashFlowQuery } from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * GET /reports/cash-flow?from=&to=
 *
 * Direct method: sums all journal lines on cash/bank GL accounts in period.
 * Cash accounts are identified by account names containing keywords:
 * نقدية | صندوق | بنك | cash | bank.
 *
 * Lines are classified by their entry's referenceType:
 *  - sales_invoice / order_collection → Operating Inflows
 *  - purchase_invoice / factory_ledger_payment / expense → Operating Outflows
 *  - fixed_asset / depreciation → Investing
 *  - everything else → Financing / Other
 */
@Controller("reports")
export class CashFlowController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("cash-flow")
  @Roles("OWNER", "ACCOUNTANT")
  async cashFlow(
    @Query(new ZodValidationPipe(CashFlowQuerySchema)) query: CashFlowQuery,
  ) {
    const from = new Date(query.from);
    const to   = new Date(query.to);
    to.setUTCHours(23, 59, 59, 999);

    // Identify cash/bank GL accounts
    const cashKeywords = ["نقدية", "صندوق", "بنك", "cash", "bank", "petty"];
    const cashAccounts = await this.prisma.account.findMany({
      where: {
        isLeaf: true,
        active: true,
        OR: cashKeywords.map((kw) => ({
          nameAr: { contains: kw, mode: "insensitive" as const },
        })),
      },
      select: { id: true, code: true, nameAr: true },
    });
    const cashAccountIds = cashAccounts.map((a) => a.id);

    if (cashAccountIds.length === 0) {
      return {
        from: query.from, to: query.to,
        cashAccounts: [],
        operatingInflow:  "0.00",
        operatingOutflow: "0.00",
        netOperating:     "0.00",
        investingInflow:  "0.00",
        investingOutflow: "0.00",
        netInvesting:     "0.00",
        otherInflow:      "0.00",
        otherOutflow:     "0.00",
        netOther:         "0.00",
        netCashFlow:      "0.00",
        lines: [],
      };
    }

    const journalLines = await this.prisma.journalLine.findMany({
      where: {
        accountId: { in: cashAccountIds },
        journalEntry: { entryDate: { gte: from, lte: to } },
      },
      include: {
        journalEntry: {
          select: {
            id: true, entryDate: true, description: true,
            referenceType: true, entryType: true,
          },
        },
        account: { select: { nameAr: true, code: true } },
      },
      orderBy: { journalEntry: { entryDate: "asc" } },
    });

    const classify = (refType: string | null): "operating" | "investing" | "other" => {
      const op = ["sales_invoice", "order_collection", "purchase_invoice",
                  "factory_ledger_payment", "expense", "RECEIPT", "EXPENSE",
                  "PURCHASE_INVOICE"];
      const inv = ["fixed_asset", "depreciation", "FIXED_ASSET"];
      if (!refType) return "other";
      if (op.some((t) => refType.toLowerCase().includes(t.toLowerCase()))) return "operating";
      if (inv.some((t) => refType.toLowerCase().includes(t.toLowerCase()))) return "investing";
      return "other";
    };

    let operatingInflow  = new Decimal(0);
    let operatingOutflow = new Decimal(0);
    let investingInflow  = new Decimal(0);
    let investingOutflow = new Decimal(0);
    let otherInflow      = new Decimal(0);
    let otherOutflow     = new Decimal(0);

    const lines = journalLines.map((l) => {
      const debit  = new Decimal(l.debit.toString());
      const credit = new Decimal(l.credit.toString());
      const refType = l.journalEntry.referenceType ?? l.journalEntry.entryType;
      const cat = classify(refType);

      if (cat === "operating") {
        operatingInflow  = operatingInflow.plus(debit);
        operatingOutflow = operatingOutflow.plus(credit);
      } else if (cat === "investing") {
        investingInflow  = investingInflow.plus(debit);
        investingOutflow = investingOutflow.plus(credit);
      } else {
        otherInflow  = otherInflow.plus(debit);
        otherOutflow = otherOutflow.plus(credit);
      }

      return {
        date:        l.journalEntry.entryDate,
        description: l.journalEntry.description,
        accountNameAr: l.account.nameAr,
        accountCode:   l.account.code,
        debit:  debit.toFixed(2),
        credit: credit.toFixed(2),
        net:    debit.minus(credit).toFixed(2),
        category: cat,
      };
    });

    const netOperating = operatingInflow.minus(operatingOutflow);
    const netInvesting = investingInflow.minus(investingOutflow);
    const netOther     = otherInflow.minus(otherOutflow);
    const netCashFlow  = netOperating.plus(netInvesting).plus(netOther);

    return {
      from: query.from,
      to:   query.to,
      cashAccounts: cashAccounts.map((a) => ({ id: a.id, code: a.code, nameAr: a.nameAr })),
      operatingInflow:  operatingInflow.toFixed(2),
      operatingOutflow: operatingOutflow.toFixed(2),
      netOperating:     netOperating.toFixed(2),
      investingInflow:  investingInflow.toFixed(2),
      investingOutflow: investingOutflow.toFixed(2),
      netInvesting:     netInvesting.toFixed(2),
      otherInflow:      otherInflow.toFixed(2),
      otherOutflow:     otherOutflow.toFixed(2),
      netOther:         netOther.toFixed(2),
      netCashFlow:      netCashFlow.toFixed(2),
      lines,
    };
  }
}
