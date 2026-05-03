/**
 * Audit follow-up — guarantees that every inventory.summary.* key referenced
 * by InventorySummaryBuilder.keyFor() resolves to a non-empty translation in
 * BOTH locales, with neither side returning the key itself.
 *
 * Why: a typo or missing entry in `inventory.json` would silently leak the
 * translation key into an audit log row's `human_readable_summary_*` —
 * Constitution Principle IV ("translation keys must NEVER be visible to
 * users") would be violated for whoever views the audit trail.
 */
import { I18nService } from "nestjs-i18n";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const SUMMARY_KEYS = [
  "RECEIPT",
  "SALE",
  "ADJUSTMENT_POSITIVE",
  "ADJUSTMENT_NEGATIVE",
  "COUNT_CORRECTION_POSITIVE",
  "COUNT_CORRECTION_NEGATIVE",
  "COUNT_CORRECTION_NO_VARIANCE",
] as const;

const ARGS = {
  actor: "Alice",
  product: "Widget",
  branch: "Cairo",
  boards: "5",
  meters: "20",
};

const ARABIC_RE = /[؀-ۿ]/;

describe("inventory.summary.* catalogue", () => {
  let handle: TestApp;
  let i18n: I18nService;

  beforeAll(async () => {
    handle = await buildTestApp();
    i18n = handle.app.get(I18nService);
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  for (const key of SUMMARY_KEYS) {
    it.each([["ar"], ["en"]] as const)(
      `inventory.summary.${key} resolves in %s`,
      async (lang) => {
        const value = (await i18n.translate(`inventory.summary.${key}`, {
          lang,
          args: ARGS,
        })) as string;
        // Missing key → nestjs-i18n returns the key itself.
        expect(value).not.toBe(`inventory.summary.${key}`);
        // Substituted args must be present
        expect(value).toContain(ARGS.actor);
        expect(value).toContain(ARGS.branch);
      },
    );
  }

  it("Arabic catalogue contains Arabic characters", async () => {
    for (const key of SUMMARY_KEYS) {
      const value = (await i18n.translate(`inventory.summary.${key}`, {
        lang: "ar",
        args: ARGS,
      })) as string;
      expect(ARABIC_RE.test(value)).toBe(true);
    }
  });

  it("English catalogue contains zero Arabic characters", async () => {
    for (const key of SUMMARY_KEYS) {
      const value = (await i18n.translate(`inventory.summary.${key}`, {
        lang: "en",
        args: ARGS,
      })) as string;
      expect(ARABIC_RE.test(value)).toBe(false);
    }
  });
});
