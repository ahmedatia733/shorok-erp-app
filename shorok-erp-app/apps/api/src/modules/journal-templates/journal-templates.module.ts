import { Module } from "@nestjs/common";
import { JournalTemplatesController } from "./journal-templates.controller";

@Module({
  controllers: [JournalTemplatesController],
})
export class JournalTemplatesModule {}
