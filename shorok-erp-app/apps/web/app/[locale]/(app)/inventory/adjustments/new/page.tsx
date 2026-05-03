"use client";

import { useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Input } from "../../../../../../components/ui/input";
import { Label } from "../../../../../../components/ui/label";
import { BranchPicker } from "../../../../../../components/features/inventory/branch-picker";
import { VariantPicker } from "../../../../../../components/features/inventory/variant-picker";
import { ApiClientError } from "../../../../../../lib/api-client";
import { postAdjustment } from "../../../../../../lib/inventory-client";

export default function AdjustmentsNewPage() {
  const t = useTranslations("inventory.adjustment");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const params = useSearchParams();

  const [branchId, setBranchId] = useState<string | null>(params.get("branchId"));
  const [variantId, setVariantId] = useState<string | null>(null);
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!branchId || !variantId || !note.trim()) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await postAdjustment({
        branchId,
        productVariantId: variantId,
        boardsDelta: delta,
        note: note.trim(),
      });
      setSuccess(true);
      setTimeout(() => router.push(`/${locale}/inventory?branchId=${branchId}`), 600);
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
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-textSecondary mb-4">{t("subtitle")}</p>
          {error ? (
            <Alert variant="error" className="mb-3">
              {error}
            </Alert>
          ) : null}
          {success ? (
            <Alert variant="success" className="mb-3">
              {t("success")}
            </Alert>
          ) : null}

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div>
              <BranchPicker value={branchId} onChange={setBranchId} />
            </div>

            <div>
              <Label htmlFor="variant">{t("variant")}</Label>
              <VariantPicker
                id="variant"
                value={variantId}
                onChange={setVariantId}
                required
                disabled={submitting}
              />
            </div>

            <div>
              <Label htmlFor="delta">{t("boardsDelta")}</Label>
              <Input
                id="delta"
                name="delta"
                type="number"
                step="0.01"
                dir="ltr"
                inputMode="decimal"
                required
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                disabled={submitting}
                placeholder="e.g. -3 or +5"
              />
            </div>

            <div>
              <Label htmlFor="note">{t("note")}</Label>
              <Input
                id="note"
                name="note"
                type="text"
                required
                minLength={1}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                {tCommon("back")}
              </Button>
              <Button
                type="submit"
                disabled={submitting || !branchId || !variantId || !delta || !note.trim()}
              >
                {submitting ? t("submitting") : t("submit")}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
