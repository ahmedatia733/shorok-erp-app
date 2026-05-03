import { Module } from "@nestjs/common";
import { ProductsSkuController } from "./products-sku.controller";
import { ProductsVariantController } from "./products-variant.controller";

@Module({
  controllers: [ProductsSkuController, ProductsVariantController],
})
export class ProductsModule {}
