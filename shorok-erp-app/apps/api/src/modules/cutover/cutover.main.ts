/**
 * Executable entry point for the cutover importer.
 *
 *   pnpm --filter @shorok/api cutover:audit  -- --manifest <path>
 *   pnpm --filter @shorok/api cutover:import -- --manifest <path> --database-url <url> --dry-run
 *   pnpm --filter @shorok/api cutover:import -- --manifest <path> --database-url <url> \
 *                                                --approval-file <path> --execute
 *
 * Exit codes: 0 success, 1 refusal (stable code printed), 2 unexpected error.
 */

import { NestFactory } from "@nestjs/core";
import { PrismaClient } from "@prisma/client";
import { AppModule } from "../../app.module";
import { PrismaService } from "../../prisma/prisma.service";
import { CutoverService } from "./cutover.service";
import { CutoverRefusal } from "./cutover.types";
import { formatSummary, parseArgs, runDatabaseGates, runManifestGates } from "./cutover.cli";
import { assertServerIdentityMatches, parseDatabaseUrl } from "./db-safety";
import type { AuthenticatedUser } from "../../common/types/request-user";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const outcome = runManifestGates(args);
  const maskedDb = await runDatabaseGates(args);

  for (const line of formatSummary(outcome, maskedDb)) console.log(line);

  if (args.mode === "audit") {
    console.log("result          : AUDIT_OK (no database was contacted)");
    return 0;
  }

  // The importer connects ONLY to the URL it was handed, never to an ambient one.
  const target = parseDatabaseUrl(args.databaseUrl);
  const probe = new PrismaClient({ datasources: { db: { url: args.databaseUrl! } } });
  try {
    const identity = await assertServerIdentityMatches(target, (sql) => probe.$queryRawUnsafe(sql));
    console.log(
      `server identity : db=${identity.currentDatabase} user=${identity.currentUser} ` +
        `addr=${identity.serverAddress ?? "socket"} pg=${identity.version.split(" ")[1] ?? "?"}`,
    );
  } finally {
    await probe.$disconnect();
  }

  process.env.DATABASE_URL = args.databaseUrl;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const service = app.get(CutoverService);
    const prisma = app.get(PrismaService);

    const branch = await prisma.branch.findFirst({ where: { active: true } });
    if (!branch) throw new CutoverRefusal("BRANCH_MISSING" as never, {});
    const actor = await prisma.user.findFirst({ where: { role: "OWNER", status: "ACTIVE" } });
    if (!actor) throw new CutoverRefusal("BRANCH_MISSING" as never, { reason: "no_owner" });

    const before = await service.businessRowCounts();
    const result = await service.run({
      mode: args.mode === "execute" ? "execute" : "dry-run",
      plan: outcome.plan,
      branchId: branch.id,
      actor: {
        id: actor.id,
        name: actor.name,
        phone: actor.phone,
        email: null,
        role: "OWNER",
        status: "ACTIVE",
        allowedBranches: [branch.id],
      } satisfies AuthenticatedUser,
      manifestSourceHashes: {},
      operator: "cli",
      approver: "cli",
      approvalDate: outcome.plan.cutoverDate,
    });
    const after = await service.businessRowCounts();

    console.log(`batch           : ${result.batchId ?? "(none)"}`);
    console.log(`customers       : +${result.createdCustomers}`);
    console.log(`skus/variants   : +${result.createdSkus}/+${result.createdVariants}`);
    console.log(`stock movements : ${result.stockMovements} (zero-qty skipped ${result.zeroQuantitySkipped})`);
    console.log(`rolled back     : ${result.rolledBack}`);
    console.log(`counts before   : ${JSON.stringify(before)}`);
    console.log(`counts after    : ${JSON.stringify(after)}`);

    if (args.mode === "dry-run") {
      const unchanged = JSON.stringify(before) === JSON.stringify(after);
      console.log(`rollback proof  : ${unchanged ? "BUSINESS ROWS UNCHANGED" : "MISMATCH"}`);
      // Sequences may advance despite rollback; business rows are the proof.
      return unchanged ? 0 : 1;
    }
    return 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof CutoverRefusal) {
      console.error(`REFUSED: ${error.code} ${JSON.stringify(error.details)}`);
      process.exit(1);
    }
    console.error("UNEXPECTED:", error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
