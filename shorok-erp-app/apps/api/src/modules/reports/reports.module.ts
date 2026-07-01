import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { IncomeStatementController } from "./income-statement.controller";
import { TrialBalanceController } from "./trial-balance.controller";
import { BalanceSheetController } from "./balance-sheet.controller";
import { AgingController } from "./aging.controller";
import { TaxLedgerController } from "./tax-ledger.controller";

@Module({
  controllers: [
    DashboardController,
    IncomeStatementController,
    TrialBalanceController,
    BalanceSheetController,
    AgingController,
    TaxLedgerController,
  ],
  providers: [DashboardService],
})
export class ReportsModule {}
