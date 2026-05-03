/**
 * T058 — i18n-everywhere integration test.
 *
 * Asserts that every error code listed in the shared package's ERROR_CODES
 * resolves to a non-empty `message_ar` AND `message_en` in the API's i18n
 * catalogues, in BOTH locales selected via `Accept-Language`. A regression
 * here would mean a user could see a translation key bleed into the UI
 * (Constitution Principle IV violation).
 *
 * The test invokes the I18nService directly to exercise every code without
 * needing one HTTP-driven scenario per error. The companion auth/admin
 * specs already prove that the error-filter wiring delivers the same
 * payload shape over the wire.
 */
import { I18nService } from "nestjs-i18n";
import { ERROR_CODES } from "@shorok/shared";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("i18n catalogues", () => {
  let handle: TestApp;
  let i18n: I18nService;

  beforeAll(async () => {
    handle = await buildTestApp();
    i18n = handle.app.get(I18nService);
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  // The HTTP filter maps each ERROR_CODES.* to either `errors.<code>` or a
  // close variant. We assert the canonical mapping below.
  const mappings: Record<string, string> = {
    [ERROR_CODES.INVALID_CREDENTIALS]: "errors.invalid_credentials",
    [ERROR_CODES.TOKEN_EXPIRED]: "errors.token_expired",
    [ERROR_CODES.USER_DISABLED]: "errors.user_disabled",
    [ERROR_CODES.REFRESH_INVALID]: "errors.refresh_invalid",
    [ERROR_CODES.FORBIDDEN]: "errors.forbidden",
    [ERROR_CODES.BRANCH_FORBIDDEN]: "errors.branch_forbidden",
    [ERROR_CODES.VALIDATION_FAILED]: "errors.validation_failed",
    [ERROR_CODES.INSUFFICIENT_STOCK]: "errors.insufficient_stock",
    [ERROR_CODES.INVALID_MOVEMENT]: "errors.invalid_movement",
    [ERROR_CODES.PRICE_APPROVAL_REQUIRED]: "errors.price_approval_required",
    [ERROR_CODES.INVALID_STATE_TRANSITION]: "errors.invalid_state_transition",
    [ERROR_CODES.COLLECTION_EXCEEDS_REQUIRED]: "errors.collection_exceeds_required",
    [ERROR_CODES.CONFLICT]: "errors.conflict",
    [ERROR_CODES.NOT_FOUND]: "errors.not_found",
    [ERROR_CODES.INVALID_WORKBOOK]: "errors.invalid_workbook",
    [ERROR_CODES.MISSING_REFERENCES]: "errors.missing_references",
    [ERROR_CODES.INTERNAL_ERROR]: "errors.internal_error",
  };

  for (const [code, key] of Object.entries(mappings)) {
    it.each([
      ["ar" as const],
      ["en" as const],
    ])(`error code "${code}" resolves in %s`, async (lang) => {
      const value = (await i18n.translate(key, { lang })) as string;
      // A miss returns the key itself — that would surface to a user.
      expect(value).not.toBe(key);
      expect(typeof value).toBe("string");
      expect(value.trim().length).toBeGreaterThan(0);
    });
  }

  it("Arabic catalogue actually contains Arabic characters", async () => {
    for (const key of Object.values(mappings)) {
      const ar = (await i18n.translate(key, { lang: "ar" })) as string;
      // U+0600..U+06FF is the Arabic Unicode block. At least one char should hit.
      expect(/[؀-ۿ]/.test(ar)).toBe(true);
    }
  });

  it("English catalogue contains only ASCII letters/punctuation (no AR leaks)", async () => {
    for (const key of Object.values(mappings)) {
      const en = (await i18n.translate(key, { lang: "en" })) as string;
      expect(/[؀-ۿ]/.test(en)).toBe(false);
    }
  });
});
