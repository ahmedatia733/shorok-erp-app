import { Module } from "@nestjs/common";
import { PeriodsController } from "./periods.controller";

@Module({
  controllers: [PeriodsController],
})
export class PeriodsModule {}
