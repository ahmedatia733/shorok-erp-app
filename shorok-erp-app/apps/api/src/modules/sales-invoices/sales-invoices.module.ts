import { Module } from "@nestjs/common";
import { SalesInvoicesController } from "./sales-invoices.controller";
import { InventoryModule } from "../inventory/inventory.module";
import { PostingModule } from "../posting/posting.module";
import { ConfigurationModule } from "../configuration/configuration.module";

@Module({
  imports: [InventoryModule, PostingModule, ConfigurationModule],
  controllers: [SalesInvoicesController],
})
export class SalesInvoicesModule {}
