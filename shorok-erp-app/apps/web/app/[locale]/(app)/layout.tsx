"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../i18n";
import { LanguageSwitcher } from "../../../components/layout/language-switcher";
import { Button } from "../../../components/ui/button";
import { useAuth } from "../../../lib/auth";

export default function ProtectedAppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const locale = useLocale() as AppLocale;
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const { user, isLoading, logout } = useAuth();

  useEffect(() => {
    if (!isLoading && !user) router.replace(`/${locale}/login`);
  }, [isLoading, user, locale, router]);

  if (isLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-textSecondary">
        {tCommon("loading")}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-64 border-e border-border bg-surface p-4">
        <div className="mb-6 text-lg font-bold">شروق · Shorok</div>
        <nav className="space-y-1 text-sm">
          {(
            [
              // [key, path, enabled]. enabled=false until that module's
              // user-story ships — keeps the nav from leaking 404s.
              ["dashboard", "/dashboard", true],
              ["orders", "/orders", true],
              ["inventory", "/inventory", true],
              ["expenses", "/expenses", true],
              ["suppliers", "/suppliers", true],
              ["factoryOrders", "/factory-orders", true],
              ["reports", "/reports", false],
              ["audit", "/audit", false],
              ["settings", "/settings", false],
            ] as const
          ).map(([key, path, enabled]) =>
            enabled ? (
              <a
                key={key}
                href={`/${locale}${path}`}
                className="block rounded-md px-3 py-2 hover:bg-background"
              >
                {t(key)}
              </a>
            ) : (
              <span
                key={key}
                aria-disabled="true"
                tabIndex={-1}
                title={tCommon("comingSoon")}
                className="flex items-center justify-between rounded-md px-3 py-2 text-textSecondary opacity-60 cursor-not-allowed"
              >
                <span>{t(key)}</span>
                <span className="text-xs uppercase tracking-wide">
                  {tCommon("comingSoon")}
                </span>
              </span>
            ),
          )}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
          <div className="text-sm text-textSecondary">{user.name}</div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              {tCommon("logout")}
            </Button>
          </div>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
