import { Module } from "@nestjs/common";
import { SalesInvoicesController } from "./sales-invoices.controller";
import { InventoryModule } from "../inventory/inventory.module";

@Module({
  imports: [InventoryModule],
  controllers: [SalesInvoicesController],
})
export class SalesInvoicesModule {}
