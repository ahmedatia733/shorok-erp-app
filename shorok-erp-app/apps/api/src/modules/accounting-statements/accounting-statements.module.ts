import { Module } from "@nestjs/common";
import { ConsolidatedStatementService } from "./consolidated-statement.service";
import { StatementService } from "./statement.service";
import { StatementsController } from "./statements.controller";

/**
 * GL-derived statements: the shared StatementService (used by the customer,
 * supplier and account statements) and the unified /statements API behind the
 * Account Statement page.
 */
@Module({
  controllers: [StatementsController],
  providers: [StatementService, ConsolidatedStatementService],
  exports: [StatementService, ConsolidatedStatementService],
})
export class AccountingStatementsModule {}
