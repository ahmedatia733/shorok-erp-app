"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { ApiClientError } from "../../../../../lib/api-client";
import {
  getSupplier,
  updateSupplier,
  type SupplierRow,
} from "../../../../../lib/suppliers-client";

export default function EditSupplierPage() {
  const t = useTranslations("suppliers");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id as string | undefined;

  const [supplier, setSupplier] = useState<SupplierRow | null>(null);
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [active, setActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await getSupplier(id);
        if (!cancelled) {
          setSupplier(data);
          setNameAr(data.nameAr);
          setNameEn(data.nameEn);
          setActive(data.active);
        }
      } catch {
        if (!cancelled) setLoadError(t("loadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!id || !nameAr.trim() || !nameEn.trim()) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await updateSupplier(id, {
        nameAr: nameAr.trim(),
        nameEn: nameEn.trim(),
        active,
      });
      setSuccess(true);
      setTimeout(() => router.push(`/${locale}/suppliers`), 600);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
      else setError(null);
    } finally {
      setSubmitting(false);
    }
  };

  if (loadError) {
    return (
      <div className="max-w-xl">
        <Alert variant="error">{loadError}</Alert>
      </div>
    );
  }

  if (!supplier) {
    return (
      <div className="max-w-xl space-y-3">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  return (
    <div className="max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("editTitle")}</CardTitle>
        </CardHeader>
        <CardBody>
          {error ? (
            <Alert variant="error" className="mb-3">
              {error}
            </Alert>
          ) : null}
          {success ? (
            <Alert variant="success" className="mb-3">
              {t("successUpdated")}
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
            <div className="flex items-center gap-2">
              <input
                id="active"
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                disabled={submitting}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
              />
              <Label htmlFor="active">{t("active")}</Label>
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
