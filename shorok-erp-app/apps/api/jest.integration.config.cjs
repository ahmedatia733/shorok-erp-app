/** Jest config for API integration tests — talks to a real Postgres test schema. */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/tests/integration/**/*.spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  moduleNameMapper: {
    "^@shorok/shared$": "<rootDir>/../../packages/shared/src/index.ts",
    "^@shorok/shared/(.*)$": "<rootDir>/../../packages/shared/src/$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  testTimeout: 30000,
  maxWorkers: 1,
  // Hard-fail before any DB connection unless TEST_DATABASE_URL is a valid,
  // dedicated LOCAL test database (globalSetup = whole run; setupFiles = each
  // worker, where it also repoints DATABASE_URL at the test DB).
  globalSetup: "<rootDir>/tests/integration/db-safety-guard.ts",
  setupFiles: ["<rootDir>/tests/integration/jest-setup-worker.ts"],
};
