import { Module } from "@nestjs/common";
import { ProductCatalogueController } from "./product-catalogue.controller";
import { ProductsSkuController } from "./products-sku.controller";
import { ProductsVariantController } from "./products-variant.controller";

@Module({
  controllers: [ProductCatalogueController, ProductsSkuController, ProductsVariantController],
})
export class ProductsModule {}
