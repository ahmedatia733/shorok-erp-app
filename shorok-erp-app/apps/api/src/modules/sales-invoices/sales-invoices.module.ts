import { Module } from "@nestjs/common";
import { SalesInvoicesController } from "./sales-invoices.controller";

@Module({
  controllers: [SalesInvoicesController],
})
export class SalesInvoicesModule {}
