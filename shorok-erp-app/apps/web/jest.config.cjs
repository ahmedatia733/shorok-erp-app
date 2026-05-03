/** Jest config for web unit tests (lib/* helpers). UI components and pages
 *  use Playwright E2E in tests/e2e/. */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/lib/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: { module: "CommonJS", moduleResolution: "node", esModuleInterop: true, strict: true, target: "ES2022" },
      },
    ],
  },
};
