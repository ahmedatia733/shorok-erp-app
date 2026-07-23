import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { PostingModule } from "../posting/posting.module";
import { ConfigurationModule } from "../configuration/configuration.module";
import { ReturnableService } from "./returnable.service";
import { SalesReturnsService } from "./sales-returns.service";
import { SalesReturnsController } from "./sales-returns.controller";
import { PurchaseReturnsService } from "./purchase-returns.service";
import { PurchaseReturnsController } from "./purchase-returns.controller";

@Module({
  imports: [InventoryModule, PostingModule, ConfigurationModule],
  controllers: [SalesReturnsController, PurchaseReturnsController],
  providers: [ReturnableService, SalesReturnsService, PurchaseReturnsService],
  exports: [ReturnableService],
})
export class ReturnsModule {}
