/** Jest config for API integration tests — these talk to a real Postgres test schema. */
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
  globalSetup: "<rootDir>/tests/integration/global-setup.ts",
  globalTeardown: "<rootDir>/tests/integration/global-teardown.ts",
  setupFilesAfterEach: [],
  testTimeout: 30000,
  // Integration tests serialize so they don't fight over the test schema.
  maxWorkers: 1,
};
