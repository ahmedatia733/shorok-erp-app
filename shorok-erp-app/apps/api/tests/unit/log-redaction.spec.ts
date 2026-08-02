/**
 * Proves that a bearer token, a session cookie or an API key can never reach a
 * log line. The regression these guard against is real: a production log line
 * for an authenticated request previously contained the caller's full JWT,
 * which is replayable until it expires.
 *
 * The paths are exercised through pino itself rather than asserted as strings,
 * so a typo in a redact path fails the test instead of silently disabling it.
 */
import pino from "pino";
import { Writable } from "node:stream";
import {
  LOG_REDACT_OPTIONS,
  LOG_REDACT_PATHS,
  LOG_REDACT_CENSOR,
  SENSITIVE_HEADERS,
} from "../../src/common/logging/log-redaction";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.SUPER_SECRET_PAYLOAD.SIGNATURE_VALUE";
const COOKIE = "shorok_refresh=abcdef123456; Path=/";
const API_KEY = "sk_live_do_not_leak_me";

/** Capture everything a logger writes, with redaction applied exactly as in prod. */
function captureLogs(fn: (log: pino.Logger) => void): string {
  let out = "";
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  const log = pino({ redact: LOG_REDACT_OPTIONS, level: "trace" }, sink);
  fn(log);
  return out;
}

describe("log redaction", () => {
  it("never writes an Authorization header value", () => {
    const out = captureLogs((log) =>
      log.info({ req: { method: "GET", url: "/api/v1/customers", headers: { authorization: `Bearer ${TOKEN}` } } }, "request"),
    );
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("Bearer ");
    expect(out).toContain(LOG_REDACT_CENSOR);
  });

  it("never writes a cookie or set-cookie value", () => {
    const out = captureLogs((log) =>
      log.info({ req: { headers: { cookie: COOKIE } }, res: { headers: { "set-cookie": COOKIE } } }, "cookies"),
    );
    expect(out).not.toContain("abcdef123456");
    expect(out).not.toContain("shorok_refresh=");
  });

  it("never writes an x-api-key value", () => {
    const out = captureLogs((log) => log.info({ req: { headers: { "x-api-key": API_KEY } } }, "api key"));
    expect(out).not.toContain(API_KEY);
  });

  it("redacts headers echoed inside a serialised error — the path that leaked", () => {
    const out = captureLogs((log) =>
      log.error(
        { err: { req: { headers: { authorization: `Bearer ${TOKEN}`, cookie: COOKIE } } }, msg: "request errored" },
        "error",
      ),
    );
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("abcdef123456");
  });

  it("redacts under request/response aliases as well as req/res", () => {
    const out = captureLogs((log) =>
      log.info(
        {
          request: { headers: { authorization: `Bearer ${TOKEN}` } },
          response: { headers: { "set-cookie": COOKIE } },
        },
        "aliases",
      ),
    );
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("abcdef123456");
  });

  it("redacts regardless of header casing", () => {
    const out = captureLogs((log) =>
      log.info(
        {
          req: { headers: { Authorization: `Bearer ${TOKEN}`, Cookie: COOKIE, "X-Api-Key": API_KEY } },
          res: { headers: { "Set-Cookie": COOKIE } },
        },
        "casing",
      ),
    );
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain("abcdef123456");
  });

  it("never writes a password or token from a request body", () => {
    const out = captureLogs((log) =>
      log.info(
        {
          req: { body: { phone: "+000000000000", password: "hunter2-not-in-logs" } },
          res: { body: { accessToken: TOKEN } },
        },
        "body",
      ),
    );
    expect(out).not.toContain("hunter2-not-in-logs");
    expect(out).not.toContain(TOKEN);
  });

  it("still logs the non-sensitive parts of a request", () => {
    const out = captureLogs((log) =>
      log.info(
        { req: { method: "GET", url: "/api/v1/customers", headers: { authorization: `Bearer ${TOKEN}`, host: "api.example.com" } } },
        "request",
      ),
    );
    // Redaction must not blind the log: the useful fields survive.
    expect(out).toContain("/api/v1/customers");
    expect(out).toContain("api.example.com");
    expect(out).toContain("GET");
  });

  it("covers every declared sensitive header in both req and res containers", () => {
    for (const header of SENSITIVE_HEADERS) {
      const secret = `SECRET_FOR_${header.toUpperCase()}`;
      const out = captureLogs((log) =>
        log.info({ req: { headers: { [header]: secret } }, res: { headers: { [header]: secret } } }, header),
      );
      expect(out).not.toContain(secret);
    }
  });

  it("declares paths for every sensitive header", () => {
    for (const header of SENSITIVE_HEADERS) {
      expect(LOG_REDACT_PATHS.some((p) => p.includes(`"${header}"`))).toBe(true);
    }
  });

  it("keeps the values censored rather than removed, so the shape stays visible", () => {
    expect(LOG_REDACT_OPTIONS.remove).toBe(false);
    expect(LOG_REDACT_OPTIONS.censor).toBe(LOG_REDACT_CENSOR);
  });
});
