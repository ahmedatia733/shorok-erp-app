import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { CancelController } from "./cancel.controller";
import { CollectionsController } from "./collections.controller";
import { ConfirmController } from "./confirm.controller";
import { OrdersController } from "./orders.controller";
import { OrdersListController } from "./orders-list.controller";
import { OrdersService } from "./orders.service";
import { OrdersSummaryBuilder } from "./orders.summary";
import { PriceApprovalController } from "./price-approval.controller";

@Module({
  imports: [InventoryModule],
  controllers: [
    OrdersController,
    OrdersListController,
    ConfirmController,
    CancelController,
    PriceApprovalController,
    CollectionsController,
  ],
  providers: [OrdersService, OrdersSummaryBuilder],
})
export class OrdersModule {}
