import { Module } from "@nestjs/common";
import { ConfigurationController } from "./configuration.controller";
import { EffectiveConfigService } from "./effective-config.service";

/**
 * Phase 2 accounting configuration. Exports EffectiveConfigService so Phase 3
 * document flows resolve posting/tax config as-of the posting date.
 */
@Module({
  controllers: [ConfigurationController],
  providers: [EffectiveConfigService],
  exports: [EffectiveConfigService],
})
export class ConfigurationModule {}
