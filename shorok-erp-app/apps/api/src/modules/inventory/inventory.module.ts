import { Module } from "@nestjs/common";
import { BranchStockController } from "./branch-stock.controller";
import { InventoryAvailabilityService } from "./inventory-availability.service";
import { AdjustmentsController } from "./adjustments.controller";
import { BalancesController } from "./balances.controller";
import { CountsController } from "./counts.controller";
import { InventoryEngine } from "./inventory.engine";
import { InventorySummaryBuilder } from "./inventory.summary";
import { MovementsController } from "./movements.controller";
import { ReceiptsController } from "./receipts.controller";

@Module({
  controllers: [
    BalancesController,
    MovementsController,
    ReceiptsController,
    AdjustmentsController,
    CountsController,
    BranchStockController,
  ],
  providers: [InventoryEngine, InventorySummaryBuilder, InventoryAvailabilityService],
  exports: [InventoryEngine, InventorySummaryBuilder, InventoryAvailabilityService],
})
export class InventoryModule {}
