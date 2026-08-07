import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { AcceptLanguageResolver, I18nModule, QueryResolver } from "nestjs-i18n";
import * as path from "node:path";
import { loadEnv } from "./config/env";
import { LOG_REDACT_OPTIONS } from "./common/logging/log-redaction";
import { ApiErrorFilter } from "./common/filters/api-error.filter";
import { BranchScopeGuard } from "./common/guards/branch-scope.guard";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { RolesGuard } from "./common/guards/roles.guard";
import { IdempotencyMiddleware } from "./common/middleware/idempotency.middleware";
import { RequestIdMiddleware } from "./common/middleware/request-id.middleware";
import { AuditModule } from "./modules/audit/audit.module";
import { AuthModule } from "./modules/auth/auth.module";
import { BranchesModule } from "./modules/branches/branches.module";
import { ExpensesModule } from "./modules/expenses/expenses.module";
import { ExpenseAccountsModule } from "./modules/expense-accounts/expense-accounts.module";
import { FactoryLedgerModule } from "./modules/factory-ledger/factory-ledger.module";
import { InventoryModule } from "./modules/inventory/inventory.module";
import { OrdersModule } from "./modules/orders/orders.module";
import { ProductsModule } from "./modules/products/products.module";
import { ImportModule } from "./modules/import/import.module";
import { ReportsModule } from "./modules/reports/reports.module";
import { SuppliersModule } from "./modules/suppliers/suppliers.module";
import { SystemSettingsModule } from "./modules/system-settings/system-settings.module";
import { UsersModule } from "./modules/users/users.module";
import { PrismaModule } from "./prisma/prisma.module";
import { AccountsModule } from "./modules/accounts/accounts.module";
import { JournalModule } from "./modules/journal/journal.module";
import { PurchaseInvoicesModule } from "./modules/purchase-invoices/purchase-invoices.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { JournalTemplatesModule } from "./modules/journal-templates/journal-templates.module";
import { CustomersModule } from "./modules/customers/customers.module";
import { FixedAssetsModule } from "./modules/fixed-assets/fixed-assets.module";
import { SalesInvoicesModule } from "./modules/sales-invoices/sales-invoices.module";
import { ReturnsModule } from "./modules/returns/returns.module";
import { InvoiceRevisionsModule } from "./modules/invoice-revisions/invoice-revisions.module";
import { HistoricalReturnsModule } from "./modules/historical-returns/historical-returns.module";
import { SalesRepresentativesModule } from "./modules/sales-representatives/sales-representatives.module";
import { ReceiptVouchersModule } from "./modules/receipt-vouchers/receipt-vouchers.module";
import { TreasuriesModule } from "./modules/treasuries/treasuries.module";
import { PostingModule } from "./modules/posting/posting.module";
import { CutoverModule } from "./modules/cutover/cutover.module";
import { PeriodsModule } from "./modules/periods/periods.module";
import { ConfigurationModule } from "./modules/configuration/configuration.module";
import { AccountingStatementsModule } from "./modules/accounting-statements/accounting-statements.module";
import { InventoryTransfersModule } from "./modules/inventory-transfers/inventory-transfers.module";

@Module({
  imports: [
    CutoverModule,
    ConfigModule.forRoot({
      isGlobal: true,
      validate: loadEnv,
      envFilePath: ["../../.env", ".env"],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === "production" ? "info" : "debug",
        transport:
          process.env.NODE_ENV === "production"
            ? undefined
            : { target: "pino-pretty", options: { colorize: true } },
        customProps: (req) => ({ requestId: (req as { id?: string }).id }),
        autoLogging: { ignore: (req) => req.url === "/health" },
        // Without this pino serialises whole headers, so every authenticated
        // request logged a replayable bearer token.
        redact: LOG_REDACT_OPTIONS,
      },
    }),
    I18nModule.forRoot({
      fallbackLanguage: "ar",
      loaderOptions: {
        path: path.join(__dirname, "i18n"),
        watch: process.env.NODE_ENV !== "production",
      },
      resolvers: [
        new QueryResolver(["locale", "lang", "l"]),
        new AcceptLanguageResolver(),
      ],
    }),
    PrismaModule,
    AuditModule,
    AuthModule,
    BranchesModule,
    UsersModule,
    ProductsModule,
    SuppliersModule,
    SystemSettingsModule,
    InventoryModule,
    InventoryTransfersModule,
    OrdersModule,
    ExpensesModule,
    ExpenseAccountsModule,
    FactoryLedgerModule,
    ReportsModule,
    AccountingStatementsModule,
    ImportModule,
    AccountsModule,
    JournalModule,
    PurchaseInvoicesModule,
    PaymentsModule,
    JournalTemplatesModule,
    CustomersModule,
    FixedAssetsModule,
    SalesInvoicesModule,
    ReturnsModule,
    InvoiceRevisionsModule,
    HistoricalReturnsModule,
    SalesRepresentativesModule,
    ReceiptVouchersModule,
    TreasuriesModule,
    PostingModule,
    PeriodsModule,
    ConfigurationModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiErrorFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: BranchScopeGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, IdempotencyMiddleware).forRoutes("*");
  }
}
