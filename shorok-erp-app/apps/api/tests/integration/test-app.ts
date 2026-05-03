/**
 * Bootstraps a Nest application against the live test schema. Each test
 * gets a real INestApplication backed by the schema set up by global-setup.
 */
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import * as bcrypt from "bcrypt";
import cookieParser from "cookie-parser";
import { INestApplication } from "@nestjs/common";
import { Logger } from "nestjs-pino";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { newSchemaName, applyMigrationsToSchema, dropSchema, TEST_SCHEMA_VAR } from "./test-db";

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  schema: string;
  ownerId: string;
  ownerPhone: string;
  ownerPassword: string;
  branchId: string;
}

export async function buildTestApp(
  customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<TestApp> {
  const schema = newSchemaName();
  process.env[TEST_SCHEMA_VAR] = schema;
  // Compose the DATABASE_URL with the per-test schema
  const baseUrl = process.env.DATABASE_URL!;
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();

  applyMigrationsToSchema(schema);

  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (customize) builder = customize(builder);
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(cookieParser());
  app.setGlobalPrefix("api/v1");
  await app.init();

  const prisma = app.get(PrismaService);

  // Seed minimal data
  const phone = "+201234567890";
  const password = "TestOwner@2026";
  const passwordHash = await bcrypt.hash(password, 10);
  const owner = await prisma.user.create({
    data: {
      name: "Test Owner",
      phone,
      passwordHash,
      role: "OWNER",
      status: "ACTIVE",
    },
  });
  const branch = await prisma.branch.create({
    data: { nameAr: "فرع اختبار", nameEn: "Test Branch", active: true },
  });

  return {
    app,
    prisma,
    schema,
    ownerId: owner.id,
    ownerPhone: phone,
    ownerPassword: password,
    branchId: branch.id,
  };
}

export async function teardownTestApp(handle: TestApp): Promise<void> {
  await handle.app.close();
  // Wait for any straggler queries before dropping
  await new Promise((r) => setTimeout(r, 50));
  dropSchema(handle.schema);
}
