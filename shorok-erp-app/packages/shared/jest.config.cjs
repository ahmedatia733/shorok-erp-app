/** Jest config for the shared package (pure TS helpers — no DOM, no DB). */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/src/**/*.test.ts"],
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
