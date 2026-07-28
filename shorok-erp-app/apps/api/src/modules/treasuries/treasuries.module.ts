import { Module } from "@nestjs/common";
import { TreasuriesController } from "./treasuries.controller";
import { TreasuriesService } from "./treasuries.service";
import { TreasuryTransfersService } from "./treasury-transfers.service";
import { PostingModule } from "../posting/posting.module";
import { ConfigurationModule } from "../configuration/configuration.module";

/**
 * Multi-treasury management (treasuries + transfers + opening balances +
 * statements). Reuses the single PostingEngine/ReversalService for all GL
 * effects — no independent balance authority.
 */
@Module({
  imports: [PostingModule, ConfigurationModule],
  controllers: [TreasuriesController],
  providers: [TreasuriesService, TreasuryTransfersService],
  exports: [TreasuriesService],
})
export class TreasuriesModule {}
