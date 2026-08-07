import { Module } from "@nestjs/common";
import { AccountsModule } from "../accounts/accounts.module";
import { InvoicePdfModule } from "../invoice-pdf/invoice-pdf.module";
import { ExpenseAccountsController } from "./expense-accounts.controller";
import { ExpenseAccountsService } from "./expense-accounts.service";

/**
 * إدارة المصروفات.
 *
 * It owns no table. AccountsModule supplies the one account-writing service, and
 * InvoicePdfModule supplies the one Chromium renderer — despite its name, that
 * service is the project's generic HTML→PDF worker and is reused here rather
 * than a second engine being introduced.
 */
@Module({
  imports: [AccountsModule, InvoicePdfModule],
  controllers: [ExpenseAccountsController],
  providers: [ExpenseAccountsService],
  exports: [ExpenseAccountsService],
})
export class ExpenseAccountsModule {}
