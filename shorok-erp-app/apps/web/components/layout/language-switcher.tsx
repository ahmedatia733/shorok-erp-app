"use client";

import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { locales, type AppLocale } from "../../i18n";
import { Button } from "../ui/button";

/**
 * Toggles the URL's locale segment (`/ar/...` ↔ `/en/...`) while preserving
 * the rest of the path and query.
 */
export function LanguageSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const current = useLocale() as AppLocale;
  const t = useTranslations("common");

  const switchTo = (next: AppLocale) => {
    if (next === current) return;
    const segments = pathname.split("/");
    if (segments[1] && (locales as readonly string[]).includes(segments[1])) {
      segments[1] = next;
    } else {
      segments.splice(1, 0, next);
    }
    router.push(segments.join("/") || "/");
    router.refresh();
  };

  return (
    <div className="inline-flex items-center gap-1" aria-label={t("language")}>
      {locales.map((l) => (
        <Button
          key={l}
          type="button"
          variant={l === current ? "primary" : "ghost"}
          size="sm"
          onClick={() => switchTo(l)}
        >
          {l === "ar" ? "ع" : "EN"}
        </Button>
      ))}
    </div>
  );
}
