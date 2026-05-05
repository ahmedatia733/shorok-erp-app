"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { ApiClientError } from "../../../../../lib/api-client";
import {
  getSystemSettings,
  updateSystemSettings,
  type SystemSettings,
} from "../../../../../lib/admin-client";

export default function SettingsSystemPage() {
  const t = useTranslations("settings.system");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;

  const [data, setData] = useState<SystemSettings | null>(null);
  const [tolerance, setTolerance] = useState("");
  const [threshold, setThreshold] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await getSystemSettings();
        if (cancelled) return;
        setData(s);
        setTolerance(s.defaultPriceOverrideTolerancePercent);
        setThreshold(s.lowStockThresholdBoards);
      } catch {
        if (!cancelled) setError(t("loadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await updateSystemSettings({
        defaultPriceOverrideTolerancePercent: tolerance.trim(),
        lowStockThresholdBoards: threshold.trim(),
      });
      setData(updated);
      setSuccess(t("successSaved"));
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardBody>
          {error ? (
            <Alert variant="error" className="mb-3">
              {error}
            </Alert>
          ) : null}
          {success ? (
            <Alert variant="success" className="mb-3">
              {success}
            </Alert>
          ) : null}
          {data === null ? (
            <Skeleton className="h-10" />
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div>
                <Label htmlFor="tolerance">{t("tolerance")}</Label>
                <Input
                  id="tolerance"
                  type="number"
                  step="0.01"
                  min="0"
                  dir="ltr"
                  required
                  value={tolerance}
                  onChange={(e) => setTolerance(e.target.value)}
                  disabled={submitting}
                />
                <p className="mt-1 text-xs text-textSecondary">{t("toleranceHint")}</p>
              </div>
              <div>
                <Label htmlFor="threshold">{t("threshold")}</Label>
                <Input
                  id="threshold"
                  type="number"
                  step="0.0001"
                  min="0"
                  dir="ltr"
                  required
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  disabled={submitting}
                />
                <p className="mt-1 text-xs text-textSecondary">{t("thresholdHint")}</p>
              </div>
              <Button type="submit" disabled={submitting || !tolerance.trim() || !threshold.trim()}>
                {submitting ? tCommon("loading") : tCommon("save")}
              </Button>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
