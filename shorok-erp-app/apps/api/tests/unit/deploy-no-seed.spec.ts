/**
 * Guards the deployment entrypoints against re-introducing a seed on start.
 *
 * `prisma/seed.ts` creates demo data — RED-01/BLU-01/GRN-01 products, a demo
 * branch and supplier, and an OWNER whose password is a literal in the file.
 * It was wired into the API container's start command, so every deploy
 * re-injected all of that into production, including a live administrator
 * account whose password is public in this repository.
 *
 * These read the real deployment files rather than a copy, so the test fails if
 * anyone puts a seed back into any start path.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "../../../../..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

/** Anything that would execute the seed at container start. */
const SEED_INVOCATION = /(prisma\s+db\s+seed|prisma:seed|\brun\s+seed\b|\bpnpm\s+seed\b|seed\.ts|seed-legacy|seed-excel)/;

describe("deployment entrypoints never seed", () => {
  const entrypoints = ["Dockerfile.api", "Dockerfile.web", "start.sh", "railpack.toml"];

  for (const file of entrypoints) {
    it(`${file} contains no seed invocation`, () => {
      const path = join(REPO_ROOT, file);
      if (!existsSync(path)) return; // optional entrypoint
      const source = readFileSync(path, "utf8");
      // Comments explaining WHY seeding is absent must not trip the check, so
      // only executable lines are examined.
      const executable = source
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n");
      expect(executable).not.toMatch(SEED_INVOCATION);
    });
  }

  it("the API start command still runs migrations and then the server", () => {
    const cmd = read("Dockerfile.api")
      .split("\n")
      .filter((l) => l.startsWith("CMD"))
      .join(" ");
    expect(cmd).toContain("prisma migrate deploy");
    expect(cmd).toContain("apps/api/dist/main");
    expect(cmd).not.toContain("db seed");
  });

  it("seeding is still available as an explicit developer command", () => {
    // Removing it from deploy must not remove it from local development.
    const pkg = JSON.parse(read("shorok-erp-app/apps/api/package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.seed).toContain("prisma/seed.ts");
  });

  it("seed-legacy.ts is never referenced by any entrypoint or package script", () => {
    for (const file of entrypoints) {
      const path = join(REPO_ROOT, file);
      if (!existsSync(path)) continue;
      expect(readFileSync(path, "utf8")).not.toContain("seed-legacy");
    }
    const pkg = read("shorok-erp-app/apps/api/package.json");
    expect(pkg).not.toContain("seed-legacy");
  });
});
