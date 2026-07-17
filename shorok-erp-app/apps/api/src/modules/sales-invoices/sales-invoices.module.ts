import { Module } from "@nestjs/common";
import { SalesInvoicesController } from "./sales-invoices.controller";
import { InventoryModule } from "../inventory/inventory.module";
import { PostingModule } from "../posting/posting.module";
import { ConfigurationModule } from "../configuration/configuration.module";
import { InvoicePdfModule } from "../invoice-pdf/invoice-pdf.module";
import { SalesRepresentativesModule } from "../sales-representatives/sales-representatives.module";

@Module({
  imports: [InventoryModule, PostingModule, ConfigurationModule, InvoicePdfModule, SalesRepresentativesModule],
  controllers: [SalesInvoicesController],
})
export class SalesInvoicesModule {}
