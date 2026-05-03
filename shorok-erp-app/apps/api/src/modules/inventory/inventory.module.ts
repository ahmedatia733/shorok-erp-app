import { Module } from "@nestjs/common";
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
  ],
  providers: [InventoryEngine, InventorySummaryBuilder],
  exports: [InventoryEngine],
})
export class InventoryModule {}
