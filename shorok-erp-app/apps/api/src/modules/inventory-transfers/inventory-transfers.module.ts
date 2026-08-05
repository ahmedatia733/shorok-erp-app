import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { InventoryTransfersController } from "./inventory-transfers.controller";
import { InventoryTransfersService } from "./inventory-transfers.service";

/**
 * Only InventoryModule is imported. There is deliberately no PostingModule:
 * a branch-to-branch move of the company's own stock has no accounting effect
 * to post, and importing the posting engine would suggest otherwise.
 */
@Module({
  imports: [InventoryModule],
  controllers: [InventoryTransfersController],
  providers: [InventoryTransfersService],
  exports: [InventoryTransfersService],
})
export class InventoryTransfersModule {}
