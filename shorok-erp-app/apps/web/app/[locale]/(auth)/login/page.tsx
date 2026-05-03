"use client";

import { useState, type FormEvent } from "react";
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

  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorKey(null);
    setSubmitting(true);
    try {
      await login(phone, password, locale);
      router.push(`/${locale}/dashboard`);
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
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold">{tApp("name")}</h1>
          <p className="text-sm text-slate-500 mt-1">{tApp("tagline")}</p>
        </div>

        <h2 className="text-lg font-semibold mb-1">{t("title")}</h2>
        <p className="text-sm text-slate-600 mb-6">{t("subtitle")}</p>

        {errorKey && (
          <div className="mb-4">
            <Alert variant="error">{tErrors(errorKey)}</Alert>
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
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
            <Button type="submit" disabled={submitting} className="grow">
              {submitting ? t("submitting") : t("submit")}
            </Button>
            <LanguageSwitcher />
          </div>
        </form>
      </div>
    </main>
  );
}
