import { Module } from "@nestjs/common";
import { HistoricalReturnsController } from "./historical-returns.controller";
import { HistoricalReturnsService } from "./historical-returns.service";

/**
 * The empty `imports` is the contract. Unlike ReturnsModule, this module
 * deliberately pulls in NEITHER PostingModule NOR InventoryModule: the archived
 * paper returns are already inside the 2026-08-01 opening balances and physical
 * count, so nothing here may ever reach the PostingEngine or the
 * InventoryEngine. Adding either import would be a regression, not a feature.
 * PrismaModule is @Global, so the read path needs no import at all.
 */
@Module({
  controllers: [HistoricalReturnsController],
  providers: [HistoricalReturnsService],
})
export class HistoricalReturnsModule {}
