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
import { FinancialReportsService } from "./financial-reports.service";
import { NetProfitController } from "./net-profit.controller";
import { InvoiceProfitabilityController } from "./invoice-profitability.controller";
import { InvoiceProfitabilityService } from "./invoice-profitability.service";
import { AccountingStatementsModule } from "../accounting-statements/accounting-statements.module";
import { InvoicePdfModule } from "../invoice-pdf/invoice-pdf.module";

@Module({
  // InvoicePdfModule is the project's generic HTML→PDF renderer, not just the
  // invoice one — the profitability export uses it rather than a second engine.
  imports: [AccountingStatementsModule, InvoicePdfModule],
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
    NetProfitController,
    InvoiceProfitabilityController,
  ],
  providers: [DashboardService, SalesRepReportsService, FinancialReportsService, InvoiceProfitabilityService],
})
export class ReportsModule {}
