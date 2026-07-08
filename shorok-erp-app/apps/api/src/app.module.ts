import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { AcceptLanguageResolver, I18nModule, QueryResolver } from "nestjs-i18n";
import * as path from "node:path";
import { loadEnv } from "./config/env";
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
import { PostingModule } from "./modules/posting/posting.module";
import { PeriodsModule } from "./modules/periods/periods.module";
import { ConfigurationModule } from "./modules/configuration/configuration.module";

@Module({
  imports: [
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
    OrdersModule,
    ExpensesModule,
    FactoryLedgerModule,
    ReportsModule,
    ImportModule,
    AccountsModule,
    JournalModule,
    PurchaseInvoicesModule,
    PaymentsModule,
    JournalTemplatesModule,
    CustomersModule,
    FixedAssetsModule,
    SalesInvoicesModule,
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
