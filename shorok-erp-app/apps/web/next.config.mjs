import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n.ts");

// API_BASE_URL is a server-side runtime env var (no NEXT_PUBLIC_ prefix needed).
// Next.js proxies /api/v1/* → the real API, so the browser never needs to know
// the API's origin — no build-time baking required.
const API_ORIGIN = process.env.API_BASE_URL ?? "http://localhost:3001";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${API_ORIGIN}/api/v1/:path*`,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
