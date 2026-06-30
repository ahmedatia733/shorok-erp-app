import { Module } from "@nestjs/common";
import { FixedAssetsController } from "./fixed-assets.controller";

@Module({ controllers: [FixedAssetsController] })
export class FixedAssetsModule {}
