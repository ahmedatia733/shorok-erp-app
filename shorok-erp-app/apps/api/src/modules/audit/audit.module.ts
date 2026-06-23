import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service";
import { AuditReadController } from "./audit-read.controller";
import { FactoryLedgerRecompute } from "../factory-ledger/recompute.sql";

@Global()
@Module({
  providers: [AuditService, FactoryLedgerRecompute],
  controllers: [AuditReadController],
  exports: [AuditService],
})
export class AuditModule {}
