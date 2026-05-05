"use client";

import { useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import type { AppLocale } from "../../../../i18n";
import { Card, CardBody } from "../../../../components/ui/card";
import { Badge } from "../../../../components/ui/badge";
import { useAuth } from "../../../../lib/auth";

interface NavEntry {
  key: "users" | "branches" | "products" | "suppliers" | "system" | "import";
  path: string;
  enabled: boolean;
}

const NAV: NavEntry[] = [
  { key: "users", path: "/settings/users", enabled: true },
  { key: "branches", path: "/settings/branches", enabled: true },
  { key: "products", path: "/settings/products", enabled: true },
  { key: "suppliers", path: "/suppliers", enabled: true },
  { key: "system", path: "/settings/system", enabled: true },
  { key: "import", path: "/settings/import", enabled: false },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && user && user.role !== "OWNER") {
      router.replace(`/${locale}/dashboard`);
    }
  }, [isLoading, user, locale, router]);

  if (isLoading || !user) {
    return null;
  }
  if (user.role !== "OWNER") {
    return null;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t("title")}</h1>
      <Card>
        <CardBody className="p-2">
          <nav className="flex flex-wrap gap-1 text-sm">
            {NAV.map((entry) => {
              const href = `/${locale}${entry.path}`;
              const isActive = pathname?.startsWith(href);
              if (!entry.enabled) {
                return (
                  <span
                    key={entry.key}
                    aria-disabled="true"
                    className="flex items-center gap-2 rounded-md px-3 py-2 text-textSecondary opacity-60 cursor-not-allowed"
                  >
                    <span>{t(`nav.${entry.key}`)}</span>
                    <Badge variant="neutral">{tCommon("comingSoon")}</Badge>
                  </span>
                );
              }
              return (
                <Link
                  key={entry.key}
                  href={href}
                  className={`rounded-md px-3 py-2 transition-colors ${
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-background"
                  }`}
                >
                  {t(`nav.${entry.key}`)}
                </Link>
              );
            })}
          </nav>
        </CardBody>
      </Card>
      {children}
    </div>
  );
}
