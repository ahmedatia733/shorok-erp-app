import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { PostingModule } from "../posting/posting.module";
import { ConfigurationModule } from "../configuration/configuration.module";
import { InvoicePdfModule } from "../invoice-pdf/invoice-pdf.module";
import { PurchaseInvoicesController } from "./purchase-invoices.controller";

@Module({
  imports: [InventoryModule, PostingModule, ConfigurationModule, InvoicePdfModule],
  controllers: [PurchaseInvoicesController],
})
export class PurchaseInvoicesModule {}
