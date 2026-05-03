import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service";
import { AuditReadController } from "./audit-read.controller";

@Global()
@Module({
  providers: [AuditService],
  controllers: [AuditReadController],
  exports: [AuditService],
})
export class AuditModule {}
