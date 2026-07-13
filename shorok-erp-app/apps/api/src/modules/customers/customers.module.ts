import { Module } from "@nestjs/common";
import { CustomersController } from "./customers.controller";
import { AccountingStatementsModule } from "../accounting-statements/accounting-statements.module";

@Module({
  imports: [AccountingStatementsModule],
  controllers: [CustomersController],
})
export class CustomersModule {}
