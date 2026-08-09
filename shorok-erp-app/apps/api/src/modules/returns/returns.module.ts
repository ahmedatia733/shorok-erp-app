import { Module } from "@nestjs/common";
import { ReturnStockService } from "./return-stock.service";
import { LegacyReturnsService } from "./legacy-returns.service";
import { LegacyReturnsController } from "./legacy-returns.controller";
import { InventoryModule } from "../inventory/inventory.module";
import { PostingModule } from "../posting/posting.module";
import { ConfigurationModule } from "../configuration/configuration.module";
import { InvoicePdfModule } from "../invoice-pdf/invoice-pdf.module";
import { ReturnableService } from "./returnable.service";
import { SalesReturnsService } from "./sales-returns.service";
import { SalesReturnsController } from "./sales-returns.controller";
import { PurchaseReturnsService } from "./purchase-returns.service";
import { PurchaseReturnsController } from "./purchase-returns.controller";

@Module({
  imports: [InventoryModule, PostingModule, ConfigurationModule, InvoicePdfModule],
  controllers: [SalesReturnsController, PurchaseReturnsController, LegacyReturnsController],
  providers: [ReturnableService, SalesReturnsService, PurchaseReturnsService, ReturnStockService, LegacyReturnsService],
  exports: [ReturnableService],
})
export class ReturnsModule {}
