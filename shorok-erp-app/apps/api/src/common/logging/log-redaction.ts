/**
 * Log redaction for pino-http.
 *
 * pino-http serialises the whole request and response, headers included, so
 * without this every log line for an authenticated call carried the caller's
 * bearer token verbatim — a token that is replayable until it expires. The same
 * applies to session cookies and API keys.
 *
 * Node lower-cases incoming header names, so the lower-case paths are the ones
 * that actually match; the capitalised variants are listed too because
 * `res.headers` echoes whatever casing the application set.
 */

/** What replaces a redacted value. Deliberately obvious in a log. */
export const LOG_REDACT_CENSOR = "[REDACTED]";

/** Header names that must never reach a log, in any casing. */
export const SENSITIVE_HEADERS = ["authorization", "cookie", "set-cookie", "x-api-key"] as const;

function headerPaths(container: string): string[] {
  return SENSITIVE_HEADERS.flatMap((h) => [
    // Bracket form handles hyphens, which dot-paths cannot express.
    `${container}["${h}"]`,
    `${container}["${h.replace(/(^|-)([a-z])/g, (_, d, c) => d + c.toUpperCase())}"]`,
    `${container}["${h.toUpperCase()}"]`,
  ]);
}

/**
 * Every place pino-http can surface headers: the request, the response, and the
 * request echoed inside a serialised error.
 */
export const LOG_REDACT_PATHS: string[] = [
  ...headerPaths("req.headers"),
  ...headerPaths("res.headers"),
  ...headerPaths("request.headers"),
  ...headerPaths("response.headers"),
  ...headerPaths("err.req.headers"),
  ...headerPaths("error.req.headers"),
  // Bodies are not logged today, but if that ever changes these must not leak.
  "req.body.password",
  "req.body.newPassword",
  "req.body.currentPassword",
  "req.body.accessToken",
  "req.body.refreshToken",
  "res.body.accessToken",
  "res.body.refreshToken",
];

export const LOG_REDACT_OPTIONS = {
  paths: LOG_REDACT_PATHS,
  censor: LOG_REDACT_CENSOR,
  // Never let a bad path silently disable the whole redaction set.
  remove: false,
};
