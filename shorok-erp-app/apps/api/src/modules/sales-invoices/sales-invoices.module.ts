import { Module } from "@nestjs/common";
import { SalesAvailabilityController } from "./sales-availability.controller";
import { SalesInvoicesController } from "./sales-invoices.controller";
import { InventoryModule } from "../inventory/inventory.module";
import { PostingModule } from "../posting/posting.module";
import { ConfigurationModule } from "../configuration/configuration.module";
import { InvoicePdfModule } from "../invoice-pdf/invoice-pdf.module";
import { SalesRepresentativesModule } from "../sales-representatives/sales-representatives.module";

@Module({
  imports: [InventoryModule, PostingModule, ConfigurationModule, InvoicePdfModule, SalesRepresentativesModule],
  // Declaration order is route-matching order in Nest: the literal
  // `/sales-invoices/available-products` must be registered before
  // `SalesInvoicesController`'s `@Get(":id")`, or the path is read as an id.
  controllers: [SalesAvailabilityController, SalesInvoicesController],
})
export class SalesInvoicesModule {}
