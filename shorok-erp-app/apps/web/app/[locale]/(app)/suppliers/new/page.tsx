"use client";

import { useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { ApiClientError } from "../../../../../lib/api-client";
import { createSupplier } from "../../../../../lib/suppliers-client";

export default function NewSupplierPage() {
  const t = useTranslations("suppliers");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const router = useRouter();

  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!nameAr.trim() || !nameEn.trim()) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await createSupplier({ nameAr: nameAr.trim(), nameEn: nameEn.trim() });
      setSuccess(true);
      setTimeout(() => router.push(`/${locale}/suppliers`), 600);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
      else setError(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("create")}</CardTitle>
        </CardHeader>
        <CardBody>
          {error ? (
            <Alert variant="error" className="mb-3">
              {error}
            </Alert>
          ) : null}
          {success ? (
            <Alert variant="success" className="mb-3">
              {t("successCreated")}
            </Alert>
          ) : null}

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div>
              <Label htmlFor="nameAr">{t("nameAr")}</Label>
              <Input
                id="nameAr"
                type="text"
                required
                maxLength={160}
                value={nameAr}
                onChange={(e) => setNameAr(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div>
              <Label htmlFor="nameEn">{t("nameEn")}</Label>
              <Input
                id="nameEn"
                type="text"
                dir="ltr"
                required
                maxLength={160}
                value={nameEn}
                onChange={(e) => setNameEn(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                {tCommon("back")}
              </Button>
              <Button
                type="submit"
                disabled={submitting || !nameAr.trim() || !nameEn.trim()}
              >
                {submitting ? t("submitting") : tCommon("save")}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
