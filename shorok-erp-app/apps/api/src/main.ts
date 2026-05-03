import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(cookieParser());
  app.setGlobalPrefix("api/v1");
  // CORS with credentials requires reflecting the exact request origin
  // (wildcard "*" is rejected by the browser when credentials are sent).
  app.enableCors({
    credentials: true,
    origin: (origin, callback) => callback(null, origin ?? false),
  });

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  app.get(Logger).log(`Shorok API listening on :${port}`);
}

void bootstrap();
