import { Module } from "@nestjs/common";
import { StatementService } from "./statement.service";

/** Provides the GL-derived StatementService to customer/supplier/account statements. */
@Module({
  providers: [StatementService],
  exports: [StatementService],
})
export class AccountingStatementsModule {}
