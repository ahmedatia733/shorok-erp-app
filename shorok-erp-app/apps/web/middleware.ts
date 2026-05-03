import createMiddleware from "next-intl/middleware";
import { defaultLocale, locales } from "./i18n";

export default createMiddleware({
  locales: [...locales],
  defaultLocale,
  localePrefix: "always",
});

export const config = {
  // Apply to all routes except API, _next internals, static files
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
