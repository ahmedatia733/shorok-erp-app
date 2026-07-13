import { Module } from "@nestjs/common";
import { PostingEngine } from "./posting.engine";
import { ReversalService } from "./reversal.service";
import { TreasuryGuardService } from "./treasury-guard.service";

/**
 * Phase 2 accounting foundation. Exports the PostingEngine and ReversalService
 * so Phase 3 document modules can post through them. No controller yet — the
 * engine is exercised by tests and, in Phase 3, by the rebuilt document flows.
 * PrismaService and AuditService come from their @Global modules.
 */
@Module({
  providers: [PostingEngine, ReversalService, TreasuryGuardService],
  exports: [PostingEngine, ReversalService, TreasuryGuardService],
})
export class PostingModule {}
