"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { AppLocale } from "../../../../i18n";
import { Alert } from "../../../../components/ui/alert";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";
import { LanguageSwitcher } from "../../../../components/layout/language-switcher";
import { ApiClientError } from "../../../../lib/api-client";
import { useAuth } from "../../../../lib/auth";

export default function LoginPage() {
  const t = useTranslations("auth");
  const tErrors = useTranslations("errors");
  const tApp = useTranslations("app");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const { login } = useAuth();

  // Read ?returnTo from the URL at submit time (client-only, so no
  // useSearchParams Suspense boundary needed). Only honour a same-app internal
  // path ("/ar/..."), never an absolute or protocol-relative URL — this
  // prevents an open-redirect via ?returnTo=.
  const safeReturnTo = (): string => {
    const raw = new URLSearchParams(window.location.search).get("returnTo");
    if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
    return `/${locale}/dashboard`;
  };

  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  // The markup is server-rendered, so the form is on screen and clickable before
  // React attaches `onSubmit`. A click in that window used to trigger the
  // browser's own submission, which for a method-less form is a GET — putting
  // the password in the URL, and from there into browser history, the Referer
  // header of every following request, and the web server's access logs.
  // Blocking submission until hydration removes that window entirely; the
  // `method="post"` on the form is the second line of defence, so that if a
  // submission ever does escape (an Enter key in an older browser, a future
  // refactor) the credentials travel in a request body rather than a URL.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorKey(null);
    setSubmitting(true);
    try {
      await login(phone, password, locale);
      router.replace(safeReturnTo());
    } catch (err) {
      if (err instanceof ApiClientError) {
        const code = err.payload.code;
        const known = ["invalid_credentials", "user_disabled", "validation_failed"];
        setErrorKey(known.includes(code) ? code : "unknown");
      } else {
        setErrorKey("network_error");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold">{tApp("name")}</h1>
          <p className="text-sm text-textSecondary mt-1">{tApp("tagline")}</p>
        </div>

        <h2 className="text-lg font-semibold mb-1">{t("title")}</h2>
        <p className="text-sm text-textSecondary mb-6">{t("subtitle")}</p>

        {errorKey && (
          <div className="mb-4">
            <Alert variant="error">{tErrors(errorKey)}</Alert>
          </div>
        )}

        <form onSubmit={onSubmit} method="post" className="space-y-4" noValidate>
          <div>
            <Label htmlFor="phone">{t("phoneLabel")}</Label>
            <Input
              id="phone"
              name="phone"
              type="tel"
              dir="ltr"
              autoComplete="tel"
              inputMode="tel"
              required
              placeholder={t("phonePlaceholder")}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div>
            <Label htmlFor="password">{t("passwordLabel")}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              dir="ltr"
              autoComplete="current-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="flex items-center justify-between gap-3 pt-2">
            <Button type="submit" disabled={submitting || !hydrated} className="grow">
              {submitting ? t("submitting") : t("submit")}
            </Button>
            <LanguageSwitcher />
          </div>
        </form>
      </div>
    </main>
  );
}
