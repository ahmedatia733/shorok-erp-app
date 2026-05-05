import { Module } from "@nestjs/common";
import { FactoryLedgerEntriesController } from "./entries.controller";
import { FactoryLedgerListController } from "./list.controller";
import { FactoryLedgerPaymentsController } from "./payments.controller";
import { FactoryLedgerRecompute } from "./recompute.sql";

@Module({
  controllers: [
    FactoryLedgerListController,
    FactoryLedgerEntriesController,
    FactoryLedgerPaymentsController,
  ],
  providers: [FactoryLedgerRecompute],
})
export class FactoryLedgerModule {}
