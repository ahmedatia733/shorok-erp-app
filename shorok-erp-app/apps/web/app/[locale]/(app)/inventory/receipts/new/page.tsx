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
import { postReceipt } from "../../../../../../lib/inventory-client";

export default function ReceiptsNewPage() {
  const t = useTranslations("inventory.receipt");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const params = useSearchParams();

  const [branchId, setBranchId] = useState<string | null>(params.get("branchId"));
  const [variantId, setVariantId] = useState<string | null>(null);
  const [boards, setBoards] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!branchId || !variantId) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await postReceipt({
        branchId,
        productVariantId: variantId,
        boardsQuantity: boards,
        note: note.trim() || undefined,
      });
      setSuccess(true);
      // Quick return to balances page
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
              <Label htmlFor="boards">{t("boardsQuantity")}</Label>
              <Input
                id="boards"
                name="boards"
                type="number"
                step="0.01"
                min="0.0001"
                dir="ltr"
                inputMode="decimal"
                required
                value={boards}
                onChange={(e) => setBoards(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div>
              <Label htmlFor="note">{t("note")}</Label>
              <Input
                id="note"
                name="note"
                type="text"
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
              <Button type="submit" disabled={submitting || !branchId || !variantId || !boards}>
                {submitting ? t("submitting") : t("submit")}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
