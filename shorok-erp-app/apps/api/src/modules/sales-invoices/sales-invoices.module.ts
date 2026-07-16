import { Module } from "@nestjs/common";
import { SalesInvoicesController } from "./sales-invoices.controller";
import { InventoryModule } from "../inventory/inventory.module";
import { PostingModule } from "../posting/posting.module";
import { ConfigurationModule } from "../configuration/configuration.module";
import { InvoicePdfModule } from "../invoice-pdf/invoice-pdf.module";

@Module({
  imports: [InventoryModule, PostingModule, ConfigurationModule, InvoicePdfModule],
  controllers: [SalesInvoicesController],
})
export class SalesInvoicesModule {}
