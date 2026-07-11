import { Module } from "@nestjs/common";
import { JournalController } from "./journal.controller";
import { PostingModule } from "../posting/posting.module";

@Module({
  imports: [PostingModule],
  controllers: [JournalController],
})
export class JournalModule {}
