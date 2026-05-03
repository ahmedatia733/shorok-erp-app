/**
 * apps/web ESLint config — extends the root config and adds two project-
 * specific rules required by the constitution (Principle IV: Localization
 * Strictness):
 *
 *   1. Direction-specific Tailwind utilities are forbidden — use logical
 *      properties (ms-, me-, ps-, pe-, start-, end-, text-start, text-end)
 *      so layouts mirror automatically when <html dir> flips.
 *
 *   2. (Aspirational, deferred to a later pass): forbid string literals
 *      in JSX text outside of t() / <Trans>. The current rule below catches
 *      the most common Tailwind-direction violations; the i18n-string check
 *      is kept as a comment so a future task can flip it on once we add
 *      eslint-plugin-i18n-text or a custom rule.
 */
module.exports = {
  root: false,
  extends: ["next/core-web-vitals"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        // Match string literals in JSX className that contain direction-
        // specific Tailwind utilities. The pattern allows them inside the
        // string (e.g., `ml-2`, `pr-4`, `left-0`).
        selector:
          "JSXAttribute[name.name='className'] Literal[value=/(?:^|\\s)(?:m|p)[lr]-|(?:^|\\s)(?:left|right)-/]",
        message:
          "Direction-specific Tailwind utility detected (ml-/mr-/pl-/pr-/left-/right-). Use logical properties (ms-/me-/ps-/pe-/start-/end-) instead so RTL/LTR mirror automatically. (Constitution Principle IV.)",
      },
      {
        // Same check inside JSXAttribute > JSXExpressionContainer > template literals
        selector:
          "JSXAttribute[name.name='className'] TemplateElement[value.raw=/(?:^|\\s)(?:m|p)[lr]-|(?:^|\\s)(?:left|right)-/]",
        message:
          "Direction-specific Tailwind utility detected (ml-/mr-/pl-/pr-/left-/right-). Use logical properties (ms-/me-/ps-/pe-/start-/end-) instead.",
      },
    ],
  },
};
