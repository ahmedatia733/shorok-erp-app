import type { Config } from "tailwindcss";

/**
 * Brand palette from `docs/ui-design/outputs/00-design-system/design.md`.
 * Tokens are exposed as Tailwind colors so utility classes mirror the design
 * system 1:1 (`bg-primary`, `text-textSecondary`, `border-border`, ...).
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Brand
        primary: {
          DEFAULT: "#0F766E", // deep teal
          hover: "#115E59",   // darker teal
          foreground: "#FFFFFF",
        },
        // Surfaces
        background: "#F8FAFC", // off-white app background
        surface: "#FFFFFF",     // cards, tables, modals
        // Text
        textPrimary: "#0F172A",   // near-black
        textSecondary: "#64748B", // muted gray
        // Lines
        border: "#E2E8F0",
        // Status
        success: {
          DEFAULT: "#15803D",
          bg: "#DCFCE7",
          foreground: "#14532D",
        },
        warning: {
          DEFAULT: "#B45309",
          bg: "#FEF3C7",
          foreground: "#78350F",
        },
        danger: {
          DEFAULT: "#B91C1C",
          bg: "#FEE2E2",
          foreground: "#7F1D1D",
        },
        info: {
          DEFAULT: "#1D4ED8",
          bg: "#DBEAFE",
          foreground: "#1E3A8A",
        },
      },
      fontSize: {
        // From the design system typography scale
        "page-title": ["28px", { lineHeight: "1.2", fontWeight: "700" }],
        "section-title": ["19px", { lineHeight: "1.3", fontWeight: "600" }],
      },
      spacing: {
        // Named tokens for clarity at call sites
        "section": "24px",
        "page": "32px",
      },
      borderRadius: {
        DEFAULT: "8px",
      },
    },
  },
  plugins: [],
};

export default config;
