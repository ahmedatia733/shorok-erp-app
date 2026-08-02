/**
 * Fresh-database preparation entry point.
 *
 *   pnpm --filter @shorok/api cutover:prepare-fresh-db -- --database-url <url> [--apply]
 *
 * Without --apply it reports what WOULD be removed and rolls back, so the
 * default of running it by mistake is a no-op.
 *
 * It carries the same database guards as the importer: explicit URL, loopback,
 * allowlist, and a live server-identity probe. It refuses the dev database and
 * every managed/public host outright.
 *
 * Exit codes: 0 success, 1 refusal, 2 unexpected error.
 */

import { PrismaClient } from "@prisma/client";
import { CutoverRefusal } from "./cutover.types";
import { assertLocalTargetIsSafe, assertServerIdentityMatches, parseDatabaseUrl } from "./db-safety";
import { prepareFreshDatabase } from "./fresh-db";

interface Args {
  databaseUrl?: string;
  apply: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--database-url") args.databaseUrl = argv[++i];
    else if (argv[i] === "--apply") args.apply = true;
  }
  return args;
}

class RollbackPreview extends Error {
  constructor(readonly report: unknown) {
    super("PREVIEW_ROLLBACK");
  }
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));

  const target = parseDatabaseUrl(args.databaseUrl);
  await assertLocalTargetIsSafe(target);
  console.log(`database        : ${target.masked}`);

  const prisma = new PrismaClient({ datasources: { db: { url: args.databaseUrl! } } });
  try {
    const identity = await assertServerIdentityMatches(target, (sql) => prisma.$queryRawUnsafe(sql));
    console.log(
      `server identity : db=${identity.currentDatabase} user=${identity.currentUser} ` +
        `addr=${identity.serverAddress ?? "socket"} pg=${identity.version.split(" ")[1] ?? "?"}`,
    );
    console.log(`mode            : ${args.apply ? "APPLY (commits)" : "PREVIEW (rolls back)"}`);

    let report;
    try {
      report = await prisma.$transaction(async (tx) => {
        const r = await prepareFreshDatabase(tx);
        if (!args.apply) throw new RollbackPreview(r);
        return r;
      });
    } catch (error) {
      if (!(error instanceof RollbackPreview)) throw error;
      report = error.report as Awaited<ReturnType<typeof prepareFreshDatabase>>;
    }

    console.log(`before          : ${JSON.stringify(report.before)}`);
    console.log(`removed         : ${JSON.stringify(report.removed)}`);
    console.log(`after           : ${JSON.stringify(report.after)}`);
    console.log(
      `retained        : accounts=${report.retained.accounts} ` +
        `systemRoleAccounts=${report.retained.systemRoleAccounts}`,
    );
    console.log(`already clean   : ${report.alreadyClean}`);

    if (args.apply) {
      const clean =
        report.after.customers === 0 &&
        report.after.productSkus === 0 &&
        report.after.productVariants === 0 &&
        report.after.suppliers === 0;
      console.log(`demo rows zero  : ${clean ? "YES" : "NO"}`);
      // A count of 0 is a real finding, not a failure of this command: the
      // migrations create the chart of accounts but assign no system_role, so
      // AR_CONTROL and friends still have to be configured before an opening
      // journal can post.
      console.log(
        `chart of accounts: ${report.retained.accounts} retained, ` +
          `${report.retained.systemRoleAccounts} with a system role` +
          (report.retained.systemRoleAccounts === 0
            ? " (system roles not yet assigned — configure before posting)"
            : ""),
      );
      return clean ? 0 : 1;
    }
    return 0;
  } finally {
    await prisma.$disconnect();
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
