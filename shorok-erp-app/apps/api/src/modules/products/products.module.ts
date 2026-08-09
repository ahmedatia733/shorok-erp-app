import { Module } from "@nestjs/common";
import { ProductCatalogueController } from "./product-catalogue.controller";
import { ProductsSkuController } from "./products-sku.controller";
import { PurchaseCatalogueController } from "./purchase-catalogue.controller";
import { ProductsVariantController } from "./products-variant.controller";

@Module({
  controllers: [
    ProductCatalogueController,
    ProductsSkuController,
    ProductsVariantController,
    PurchaseCatalogueController,
  ],
})
export class ProductsModule {}
