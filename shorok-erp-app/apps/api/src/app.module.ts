import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { AcceptLanguageResolver, I18nModule, QueryResolver } from "nestjs-i18n";
import * as path from "node:path";
import { loadEnv } from "./config/env";
import { ApiErrorFilter } from "./common/filters/api-error.filter";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { RolesGuard } from "./common/guards/roles.guard";
import { IdempotencyMiddleware } from "./common/middleware/idempotency.middleware";
import { RequestIdMiddleware } from "./common/middleware/request-id.middleware";
import { AuditModule } from "./modules/audit/audit.module";
import { AuthModule } from "./modules/auth/auth.module";
import { PrismaModule } from "./prisma/prisma.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: loadEnv,
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
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiErrorFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, IdempotencyMiddleware).forRoutes("*");
  }
}
