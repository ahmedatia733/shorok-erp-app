import { Controller, Get, Query } from "@nestjs/common";
import {
  IncomeStatementQuerySchema,
  type IncomeStatementQuery,
} from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { FinancialReportsService } from "./financial-reports.service";

@Controller("reports")
export class IncomeStatementController {
  constructor(private readonly financial: FinancialReportsService) {}

  /**
   * GET /reports/income-statement?from=&to= — OWNER only.
   *
   * Journal-based P&L for the range. Uses ONLY active posted entries
   * (status=POSTED AND reversal_of_id IS NULL), so reversed/cancelled documents
   * net to zero. Never derived from invoices; never mutates data.
   */
  @Get("income-statement")
  @Roles("OWNER")
  async incomeStatement(
    @Query(new ZodValidationPipe(IncomeStatementQuerySchema)) query: IncomeStatementQuery,
  ) {
    return this.financial.pnl(query.from, query.to);
  }
}
