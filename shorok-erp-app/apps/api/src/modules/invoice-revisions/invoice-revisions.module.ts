import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { PostingModule } from "../posting/posting.module";
import { ConfigurationModule } from "../configuration/configuration.module";
import { ReturnsModule } from "../returns/returns.module";
import { PostingPeriodService } from "./posting-period.service";
import { ValuationReplayService } from "./valuation-replay.service";
import { SalesInvoiceRevisionService } from "./sales-invoice-revision.service";
import { PurchaseInvoiceRevisionService } from "./purchase-invoice-revision.service";
import {
  PurchaseInvoiceRevisionsController,
  SalesInvoiceRevisionsController,
} from "./invoice-revisions.controller";

@Module({
  imports: [InventoryModule, PostingModule, ConfigurationModule, ReturnsModule],
  controllers: [SalesInvoiceRevisionsController, PurchaseInvoiceRevisionsController],
  providers: [
    PostingPeriodService,
    ValuationReplayService,
    SalesInvoiceRevisionService,
    PurchaseInvoiceRevisionService,
  ],
  exports: [ValuationReplayService],
})
export class InvoiceRevisionsModule {}
