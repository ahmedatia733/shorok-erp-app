import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { FinancialReportsService } from "./financial-reports.service";

const Query$ = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
type Query$ = z.infer<typeof Query$>;

/**
 * §10 — company net profit, from the SAME journal-based P&L the income statement
 * uses, so the two reconcile exactly. The current chart classifies expenses as a
 * single bucket, so operatingExpenses = total expenses and other income/expenses
 * are 0 until dedicated account sub-classes exist.
 */
@Controller("reports/financial")
export class NetProfitController {
  constructor(private readonly financial: FinancialReportsService) {}

  @Get("net-profit")
  @Roles("OWNER")
  async netProfit(@Query(new ZodValidationPipe(Query$)) q: Query$) {
    const p = await this.financial.pnl(q.from, q.to);
    return {
      from: p.from, to: p.to,
      netRevenue: p.revenue,
      costOfSales: p.costOfSales,
      grossProfit: p.grossProfit,
      operatingExpenses: p.totalExpenses,
      otherIncome: "0.00",
      otherExpenses: "0.00",
      netProfit: p.netProfit,
      note: "يطابق قائمة الدخل. الإيرادات/المصروفات الأخرى = 0 حتى تُضاف تصنيفات حسابات مخصصة.",
    };
  }
}
