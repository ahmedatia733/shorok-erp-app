import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { IncomeStatementController } from "./income-statement.controller";

@Module({
  controllers: [DashboardController, IncomeStatementController],
  providers: [DashboardService],
})
export class ReportsModule {}
