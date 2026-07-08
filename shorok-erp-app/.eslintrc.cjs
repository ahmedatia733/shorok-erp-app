/** Root ESLint config — apps may extend with their own .eslintrc.cjs. */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: [
    "node_modules",
    "dist",
    ".next",
    "build",
    "coverage",
    "**/*.config.{js,cjs,mjs,ts}",
    "next-env.d.ts",
  ],
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/consistent-type-imports": "warn",
  },
  overrides: [
    {
      // Constitution VI — Single Posting Path: journal entries/lines may only
      // be created by the PostingEngine. Phase 2 ships this as a WARNING with
      // the posting module exempt; the 8 legacy direct writers therefore warn
      // (a visible migration signal) without breaking the build. It flips to
      // "error" per-caller as Phase 3 migrates each flow onto the engine.
      files: ["apps/api/src/**/*.ts"],
      excludedFiles: ["apps/api/src/modules/posting/**", "apps/api/**/*.spec.ts"],
      rules: {
        "no-restricted-syntax": [
          "warn",
          {
            selector:
              "CallExpression[callee.property.name='create'][callee.object.property.name='journalEntry']",
            message:
              "Direct journalEntry.create is forbidden (Constitution VI). Post through PostingEngine. Legacy callers are being migrated in Phase 3.",
          },
          {
            selector:
              "CallExpression[callee.property.name='create'][callee.object.property.name='journalLine']",
            message:
              "Direct journalLine.create is forbidden (Constitution VI). Post through PostingEngine.",
          },
        ],
      },
    },
  ],
};
