import { Module } from "@nestjs/common";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";
import { InventoryModule } from "../inventory/inventory.module";
import { AuditModule } from "../audit/audit.module";
import { FactoryLedgerRecompute } from "../factory-ledger/recompute.sql";

@Module({
  imports: [InventoryModule, AuditModule],
  controllers: [ImportController],
  providers: [ImportService, FactoryLedgerRecompute],
})
export class ImportModule {}
