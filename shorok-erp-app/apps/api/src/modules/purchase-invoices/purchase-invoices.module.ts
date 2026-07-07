import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { PurchaseInvoicesController } from "./purchase-invoices.controller";

@Module({
  imports: [InventoryModule],
  controllers: [PurchaseInvoicesController],
})
export class PurchaseInvoicesModule {}
