import { Module } from "@nestjs/common";
import { SystemSettingsController } from "./system-settings.controller";

@Module({
  controllers: [SystemSettingsController],
})
export class SystemSettingsModule {}
