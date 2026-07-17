import { Module } from "@nestjs/common";
import { SalesRepresentativesController } from "./sales-representatives.controller";
import { SalesRepresentativesService } from "./sales-representatives.service";
import { AccountingStatementsModule } from "../accounting-statements/accounting-statements.module";

@Module({
  imports: [AccountingStatementsModule],
  controllers: [SalesRepresentativesController],
  providers: [SalesRepresentativesService],
  exports: [SalesRepresentativesService],
})
export class SalesRepresentativesModule {}
