import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { IncomeStatementController } from "./income-statement.controller";
import { TrialBalanceController } from "./trial-balance.controller";
import { BalanceSheetController } from "./balance-sheet.controller";
import { AgingController } from "./aging.controller";
import { TaxLedgerController } from "./tax-ledger.controller";
import { SupplierStatementController } from "./supplier-statement.controller";
import { SupplierAgingController } from "./supplier-aging.controller";
import { CashFlowController } from "./cash-flow.controller";
import { SalesRepReportsController, SalesTimeSeriesController } from "./sales-rep-reports.controller";
import { SalesRepReportsService } from "./sales-rep-reports.service";
import { AccountingStatementsModule } from "../accounting-statements/accounting-statements.module";

@Module({
  imports: [AccountingStatementsModule],
  controllers: [
    DashboardController,
    IncomeStatementController,
    TrialBalanceController,
    BalanceSheetController,
    AgingController,
    TaxLedgerController,
    SupplierStatementController,
    SupplierAgingController,
    CashFlowController,
    SalesRepReportsController,
    SalesTimeSeriesController,
  ],
  providers: [DashboardService, SalesRepReportsService],
})
export class ReportsModule {}
