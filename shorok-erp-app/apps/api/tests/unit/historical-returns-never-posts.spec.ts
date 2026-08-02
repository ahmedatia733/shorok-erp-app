/**
 * The historical sales-return archive must never post, and must never grow a
 * write route.
 *
 * The six archived July 2026 paper returns are EVIDENCE, not documents. Their
 * customer effect is already inside the approved 2026-08-01 opening AR balances
 * and their stock effect is already inside the 2026-08-01 physical count, so a
 * single posting call would double-count a live production ledger.
 *
 * Like deploy-no-seed.spec.ts, this reads the REAL module off disk — plus the
 * REAL Nest metadata the decorators wrote — instead of a copy, so it fails the
 * moment someone wires PostingEngine, InventoryEngine or a POST/PUT/PATCH/DELETE
 * handler into the module. Every probe is first proved against a file or module
 * that genuinely does post, so a passing run cannot mean "the probe is blind".
 */
import "reflect-metadata";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { HistoricalReturnsController } from "../../src/modules/historical-returns/historical-returns.controller";
import { HistoricalReturnsModule } from "../../src/modules/historical-returns/historical-returns.module";
import { HistoricalReturnsService } from "../../src/modules/historical-returns/historical-returns.service";
import { InventoryModule } from "../../src/modules/inventory/inventory.module";
import { PostingModule } from "../../src/modules/posting/posting.module";
import { ReturnsModule } from "../../src/modules/returns/returns.module";

const API_ROOT = join(__dirname, "../..");
const MODULE_DIR = join(API_ROOT, "src/modules/historical-returns");
const read = (abs: string) => readFileSync(abs, "utf8");

/**
 * The module's doc comments deliberately NAME the engines they refuse to use,
 * so a raw grep would fail on prose. Only executable code is examined — the
 * same rule deploy-no-seed.spec.ts applies to shell comments.
 */
function executableCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block + JSDoc comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments, but not "https://"
}

/** Anything that would carry an archive row into the ledger or the stock. */
const POSTING_REFERENCES = [
  "PostingEngine",
  "InventoryEngine",
  "journalEntry",
  "inventoryMovement",
  "customerTransaction",
] as const;

/** Anything that would turn a GET-only controller into a write surface. */
const WRITE_DECORATORS = ["@Post(", "@Put(", "@Patch(", "@Delete("] as const;

const moduleFiles = readdirSync(MODULE_DIR).filter((f) => f.endsWith(".ts"));

/** Walks the @Module import graph the way Nest itself resolves it. */
function reachableModules(root: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null || seen.has(current)) continue;
    seen.add(current);
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, current as object) ?? []) as unknown[];
    for (const imported of imports) queue.push(imported);
  }
  seen.delete(root);
  return seen;
}

describe("historical-returns module never posts", () => {
  it("the module directory is the three files this test believes it is", () => {
    // A new file in this directory must be covered by the scans below, so the
    // inventory is asserted rather than assumed.
    expect(moduleFiles.sort()).toEqual([
      "historical-returns.controller.ts",
      "historical-returns.module.ts",
      "historical-returns.service.ts",
    ]);
  });

  it.each(moduleFiles)("%s references no posting, inventory or customer-ledger write", (file) => {
    const code = executableCode(read(join(MODULE_DIR, file)));
    // Proves the comment stripper did not simply blank the file out.
    expect(code).toMatch(/export class HistoricalReturns/);
    for (const reference of POSTING_REFERENCES) expect(code).not.toContain(reference);
  });

  it("the same scan DOES flag the modules that genuinely post", () => {
    // Without this the scan above could pass by being broken. sales-returns
    // posts and touches the customer ledger; the inventory engine writes
    // movements. Between them every forbidden reference is detected.
    const salesReturns = executableCode(read(join(API_ROOT, "src/modules/returns/sales-returns.service.ts")));
    const inventory = executableCode(read(join(API_ROOT, "src/modules/inventory/inventory.engine.ts")));
    for (const reference of POSTING_REFERENCES) {
      expect(salesReturns.includes(reference) || inventory.includes(reference)).toBe(true);
    }
  });

  it("imports neither PostingModule nor InventoryModule — directly or transitively", () => {
    const direct = Reflect.getMetadata(MODULE_METADATA.IMPORTS, HistoricalReturnsModule) as unknown[] | undefined;
    expect(direct ?? []).toEqual([]);

    const reachable = reachableModules(HistoricalReturnsModule);
    expect(reachable.has(PostingModule)).toBe(false);
    expect(reachable.has(InventoryModule)).toBe(false);
    expect(reachable.size).toBe(0);
  });

  it("the same import walk DOES find both engines under ReturnsModule", () => {
    // ReturnsModule is the operational sibling that must post. If the walk
    // cannot see the engines there, it proves nothing about their absence here.
    const reachable = reachableModules(ReturnsModule);
    expect(reachable.has(PostingModule)).toBe(true);
    expect(reachable.has(InventoryModule)).toBe(true);
  });

  it("declares exactly one controller and one provider, both read-only", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, HistoricalReturnsModule)).toEqual([
      HistoricalReturnsController,
    ]);
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, HistoricalReturnsModule) ?? []) as unknown[];
    expect(providers).toEqual([HistoricalReturnsService]);
  });

  it("the one-time importer script cannot post either", () => {
    // The script counts journal/inventory/customer rows before and after to
    // prove its own no-op, so it legitimately NAMES them. What it must never do
    // is create one, or reach for an engine.
    const code = executableCode(read(join(API_ROOT, "scripts/import-historical-returns.ts")));
    expect(code).toContain("historicalSalesReturnArchive.create");
    expect(code).not.toContain("PostingEngine");
    expect(code).not.toContain("InventoryEngine");
    for (const model of ["journalEntry", "journalLine", "inventoryMovement", "customerTransaction"]) {
      expect(code).not.toContain(`${model}.create`);
      expect(code).not.toContain(`${model}.update`);
      expect(code).not.toContain(`${model}.upsert`);
    }
  });
});

describe("historical-returns module exposes no write route", () => {
  const routes = Object.getOwnPropertyNames(HistoricalReturnsController.prototype)
    .filter((name) => name !== "constructor")
    .map((name) => {
      const handler = (HistoricalReturnsController.prototype as Record<string, unknown>)[name] as object;
      return {
        name,
        path: Reflect.getMetadata(PATH_METADATA, handler) as string | undefined,
        method: Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined,
      };
    })
    .filter((r) => r.path !== undefined);

  it("every registered route handler is a GET", () => {
    // Non-vacuous: the controller really does register routes, and all of them
    // are reads.
    expect(routes.map((r) => r.name).sort()).toEqual(["get", "list"]);
    for (const route of routes) expect(route.method).toBe(RequestMethod.GET);
    expect(routes.map((r) => r.path).sort()).toEqual(["/", ":id"]);
  });

  it.each(moduleFiles)("%s declares no @Post/@Put/@Patch/@Delete handler", (file) => {
    const code = executableCode(read(join(MODULE_DIR, file)));
    for (const decorator of WRITE_DECORATORS) expect(code).not.toContain(decorator);
  });

  it("the controller still declares @Get, so the decorator scan is looking at real code", () => {
    const controller = executableCode(read(join(MODULE_DIR, "historical-returns.controller.ts")));
    expect(controller).toContain("@Get(");
    // And the scan finds a write decorator where one genuinely exists.
    const operational = executableCode(read(join(API_ROOT, "src/modules/returns/sales-returns.controller.ts")));
    expect(WRITE_DECORATORS.some((d) => operational.includes(d))).toBe(true);
  });

  it("the shared contract offers no create, update, confirm or cancel schema", () => {
    // A write route needs a body schema; there is deliberately none to import.
    const contract = executableCode(
      read(join(API_ROOT, "../../packages/shared/src/schemas/api/historical-returns.ts")),
    );
    for (const forbidden of ["Create", "Update", "Confirm", "Cancel", "Delete"]) {
      expect(contract).not.toMatch(new RegExp(`HistoricalSalesReturn\\w*${forbidden}`));
    }
    expect(contract).toContain("HistoricalSalesReturnQuerySchema"); // read contract intact
  });
});
