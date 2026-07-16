import { defineConfig, devices } from "@playwright/test";

/**
 * E2E suite spins up both apps via the runner's `webServer` block.
 *
 * Uses the SAME ports as `pnpm dev` / production defaults (web 3000,
 * api 3001) because `NEXT_PUBLIC_API_BASE_URL` is inlined into the web
 * bundle at build time — the bundle hard-codes `http://localhost:3001/api/v1`
 * unless re-built with a different value, so the API must match.
 *
 * Prerequisites (handled by `pnpm test:e2e:setup` from `apps/web`):
 *   1. `pnpm --filter @shorok/api build`  → produces dist/main.js
 *   2. `pnpm --filter @shorok/web build`  → produces .next/
 *   3. `pnpm --filter @shorok/api seed`   → seeds the demo OWNER
 *
 * Then `pnpm --filter @shorok/web test:e2e` runs this suite.
 *
 * The runner reuses any already-running dev servers (`reuseExistingServer`)
 * outside CI so re-running tests is fast.
 */
const PORT = 3000;
const API_PORT = 3001;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `node ../api/dist/main.js`,
      cwd: ".",
      env: {
        DATABASE_URL:
          process.env.DATABASE_URL ??
          "postgresql://shorok:shorok@localhost:5432/shorok_erp?schema=public",
        JWT_ACCESS_SECRET: "e2e-access-secret-1234567890",
        JWT_REFRESH_SECRET: "e2e-refresh-secret-1234567890",
        JWT_ACCESS_TTL: "15m",
        JWT_REFRESH_TTL: "7d",
        DEFAULT_LOCALE: "ar",
        API_PORT: String(API_PORT),
        NODE_ENV: "production",
        // Invoice PDF rendering uses Chromium; point at a local binary for E2E.
        CHROME_PATH:
          process.env.CHROME_PATH ??
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      // /auth/me without a token returns 401 — that's the readiness signal.
      url: `http://localhost:${API_PORT}/api/v1/auth/me`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `pnpm start -p ${PORT}`,
      cwd: ".",
      env: { PORT: String(PORT) },
      url: `http://localhost:${PORT}/ar/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
