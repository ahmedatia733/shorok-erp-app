import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { IncomeStatementController } from "./income-statement.controller";
import { TrialBalanceController } from "./trial-balance.controller";
import { BalanceSheetController } from "./balance-sheet.controller";
import { AgingController } from "./aging.controller";

@Module({
  controllers: [
    DashboardController,
    IncomeStatementController,
    TrialBalanceController,
    BalanceSheetController,
    AgingController,
  ],
  providers: [DashboardService],
})
export class ReportsModule {}
