import { Module } from "@nestjs/common";
import { ExpensesController } from "./expenses.controller";
import { PostingModule } from "../posting/posting.module";
import { ConfigurationModule } from "../configuration/configuration.module";

@Module({
  imports: [PostingModule, ConfigurationModule],
  controllers: [ExpensesController],
})
export class ExpensesModule {}
