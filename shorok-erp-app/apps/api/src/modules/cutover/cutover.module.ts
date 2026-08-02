import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { PostingModule } from "../posting/posting.module";
import { CutoverService } from "./cutover.service";

/**
 * Opening-data cutover import. Deliberately exposes NO controller: this is a
 * CLI-only operation that must always be invoked with an explicit database
 * target, never over HTTP against whatever database the API happens to serve.
 */
@Module({
  imports: [InventoryModule, PostingModule],
  providers: [CutoverService],
  exports: [CutoverService],
})
export class CutoverModule {}
