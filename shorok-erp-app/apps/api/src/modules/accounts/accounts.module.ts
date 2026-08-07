import { Module } from "@nestjs/common";
import { AccountsController } from "./accounts.controller";
import { AccountsService } from "./accounts.service";

/**
 * Chart of Accounts master data.
 *
 * AccountsService is exported because the Expenses area creates and edits
 * expense accounts through it — an expense item IS a Chart-of-Accounts account,
 * so it must be written by the same code that writes every other account.
 */
@Module({
  controllers: [AccountsController],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
