import { Module } from "@nestjs/common";
import { PurchaseInvoicesController } from "./purchase-invoices.controller";

@Module({
  controllers: [PurchaseInvoicesController],
})
export class PurchaseInvoicesModule {}
