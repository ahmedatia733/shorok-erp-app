/**
 * §2 — TEST_DATABASE_URL safety guard. Pure validation (no DB) proving the five
 * required cases. (Runs under the integration config, whose own globalSetup
 * already proved the REAL TEST_DATABASE_URL is a valid local test database.)
 */
import { validateTestUrl } from "./db-safety-guard";

const LOCAL_TEST = "postgresql://u:p@localhost:5432/shorok_erp_test";
const DEV = "postgresql://u:p@localhost:5432/shorok_erp";

describe("validateTestUrl (§2)", () => {
  it("1) local TEST_DATABASE_URL (name contains 'test') passes", () => {
    expect(validateTestUrl({ testUrl: LOCAL_TEST, devUrl: DEV })).toBe(LOCAL_TEST);
    expect(validateTestUrl({ testUrl: "postgresql://u:p@127.0.0.1:5432/erp_test" })).toBeTruthy();
  });

  it("2) a Railway-style URL fails", () => {
    expect(() => validateTestUrl({ testUrl: "postgresql://u:p@turntable.proxy.rlwy.net:5432/railway_test" }))
      .toThrow(/production|railway/i);
  });

  it("3) missing TEST_DATABASE_URL fails", () => {
    expect(() => validateTestUrl({ testUrl: undefined, devUrl: DEV })).toThrow(/not set/i);
    expect(() => validateTestUrl({ testUrl: "" })).toThrow(/not set/i);
  });

  it("4) TEST_DATABASE_URL equal to DATABASE_URL fails", () => {
    expect(() => validateTestUrl({ testUrl: DEV.replace("shorok_erp", "shorok_erp_test"), devUrl: DEV.replace("shorok_erp", "shorok_erp_test") }))
      .toThrow(/equals DATABASE_URL/i);
  });

  it("5) a database name WITHOUT 'test' fails", () => {
    expect(() => validateTestUrl({ testUrl: DEV, devUrl: "postgresql://u:p@localhost:5432/other" }))
      .toThrow(/must clearly contain "test"/i);
  });

  it("also: equals PROD_DATABASE_URL fails, and non-loopback fails, and NODE_ENV=production fails", () => {
    expect(() => validateTestUrl({ testUrl: LOCAL_TEST, prodUrl: LOCAL_TEST })).toThrow(/PROD_DATABASE_URL/i);
    expect(() => validateTestUrl({ testUrl: "postgresql://u:p@db.example.com:5432/app_test" })).toThrow(/loopback/i);
    expect(() => validateTestUrl({ testUrl: LOCAL_TEST, nodeEnv: "production" })).toThrow(/NODE_ENV=production/i);
  });
});
