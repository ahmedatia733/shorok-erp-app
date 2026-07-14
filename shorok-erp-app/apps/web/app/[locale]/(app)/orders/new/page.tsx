"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { BranchPicker } from "../../../../../components/features/inventory/branch-picker";
import { ProductVariantSelect } from "../../../../../components/features/product-variant-select";
import { type VariantItem } from "../../../../../lib/variant-select";
import { ApiClientError } from "../../../../../lib/api-client";
import {
  listVariants,
  type VariantOption,
} from "../../../../../lib/inventory-client";
import { createOrder } from "../../../../../lib/orders-client";
import { formatCurrency, formatNumber } from "../../../../../lib/format";

/**
 * Pure-display deviation in percent. The SERVER classifies authoritatively
 * with decimal.js; this client-side computation is for the visual indicator
 * only and never gets stored. Returns null for malformed input.
 */
function clientDeviationPercent(sale: string, def: string): number | null {
  const s = Number(sale);
  const d = Number(def);
  if (!isFinite(s) || !isFinite(d) || d === 0) return null;
  return Math.abs((s - d) / d) * 100;
}

export default function NewOrderPage() {
  const t = useTranslations("orders");
  const tForm = useTranslations("orders.form");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const params = useSearchParams();

  const [branchId, setBranchId] = useState<string | null>(params.get("branchId"));
  const [variants, setVariants] = useState<VariantOption[]>([]);
  const [variantId, setVariantId] = useState<string>("");
  const variantItems: VariantItem[] = variants.map((v) => ({
    id: v.id, skuCode: v.sku.code, colorNameAr: v.sku.colorNameAr, colorNameEn: v.sku.colorNameEn, sizeMetersPerBoard: v.sizeMetersPerBoard,
  }));
  const [customer, setCustomer] = useState("");
  const [boards, setBoards] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [receiver, setReceiver] = useState("");
  const [initialCollection, setInitialCollection] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listVariants().then((rows) => setVariants(rows.filter((v) => v.active)));
  }, []);

  const selected = useMemo(
    () => variants.find((v) => v.id === variantId) ?? null,
    [variants, variantId],
  );

  // Pre-fill the price input with the variant's default when a variant is
  // chosen. Operator can edit; deviation is shown live below.
  useEffect(() => {
    if (selected && !salePrice) setSalePrice(selected.defaultSalePricePerMeter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const tolerancePercent = useMemo(() => {
    if (!selected) return null;
    // Variant's own tolerance, falling back to whatever the API/system uses.
    // The server is authoritative; this is for the visual hint only.
    return Number(selected.priceOverrideTolerancePercent ?? "5.00");
  }, [selected]);

  const deviation = useMemo(() => {
    if (!selected) return null;
    return clientDeviationPercent(salePrice, selected.defaultSalePricePerMeter);
  }, [selected, salePrice]);

  const isWithinTolerance =
    deviation !== null && tolerancePercent !== null && deviation <= tolerancePercent;

  // Display-only required-amount preview
  const requiredPreview = useMemo(() => {
    if (!selected) return null;
    const b = Number(boards);
    const p = Number(salePrice);
    const size = Number(selected.sizeMetersPerBoard);
    if (!isFinite(b) || !isFinite(p) || !isFinite(size)) return null;
    return b * size * p;
  }, [selected, boards, salePrice]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!branchId || !variantId) return;
    setSubmitting(true);
    setError(null);
    try {
      const order = await createOrder({
        branchId,
        productVariantId: variantId,
        customerName: customer.trim(),
        boardsQuantity: boards,
        salePricePerMeter: salePrice,
        receiverName: receiver.trim() || undefined,
        initialCollectionAmount: initialCollection.trim() || undefined,
      });
      router.push(`/${locale}/orders/${order.id}`);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
      else setError(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl">
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

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div>
              <BranchPicker value={branchId} onChange={setBranchId} />
            </div>

            <div>
              <Label htmlFor="customer">{tForm("customer")}</Label>
              <Input
                id="customer"
                name="customer"
                type="text"
                required
                maxLength={160}
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div>
              <Label htmlFor="variant">{tForm("product")}</Label>
              <ProductVariantSelect
                variants={variantItems}
                value={variantId}
                onChange={setVariantId}
                disabled={submitting}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <Label htmlFor="boards">{tForm("boardsQuantity")}</Label>
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
                <Label htmlFor="price">{tForm("salePricePerMeter")}</Label>
                <Input
                  id="price"
                  name="price"
                  type="number"
                  step="0.01"
                  min="0.01"
                  dir="ltr"
                  inputMode="decimal"
                  required
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  disabled={submitting}
                />
              </div>
            </div>

            {selected ? (
              <Card>
                <CardBody className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-textSecondary">{tForm("defaultPrice")}</span>
                    <span dir="ltr" className="font-medium">
                      {formatCurrency(selected.defaultSalePricePerMeter, locale)}
                    </span>
                  </div>
                  {tolerancePercent !== null ? (
                    <div className="flex items-center justify-between">
                      <span className="text-textSecondary">{tForm("tolerance")}</span>
                      <span dir="ltr">±{formatNumber(tolerancePercent.toFixed(2), locale)}%</span>
                    </div>
                  ) : null}
                  {deviation !== null ? (
                    <div className="flex items-center justify-between">
                      <span className="text-textSecondary">{tForm("deviation")}</span>
                      <span
                        dir="ltr"
                        className={
                          isWithinTolerance ? "text-success font-medium" : "text-warning font-medium"
                        }
                      >
                        {formatNumber(deviation.toFixed(2), locale)}%
                      </span>
                    </div>
                  ) : null}
                  {deviation !== null ? (
                    <Alert variant={isWithinTolerance ? "success" : "warning"}>
                      {isWithinTolerance ? tForm("withinTolerance") : tForm("outsideTolerance")}
                    </Alert>
                  ) : null}
                  {requiredPreview !== null ? (
                    <div className="flex items-center justify-between border-t border-border pt-2">
                      <span className="text-textSecondary">{t("columns.required")}</span>
                      <span dir="ltr" className="font-medium">
                        {formatCurrency(requiredPreview.toFixed(2), locale)}
                      </span>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            ) : null}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <Label htmlFor="receiver">{tForm("receiver")}</Label>
                <Input
                  id="receiver"
                  name="receiver"
                  type="text"
                  maxLength={160}
                  value={receiver}
                  onChange={(e) => setReceiver(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div>
                <Label htmlFor="initialCollection">{tForm("initialCollection")}</Label>
                <Input
                  id="initialCollection"
                  name="initialCollection"
                  type="number"
                  step="0.01"
                  min="0"
                  dir="ltr"
                  inputMode="decimal"
                  value={initialCollection}
                  onChange={(e) => setInitialCollection(e.target.value)}
                  disabled={submitting}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                {tCommon("back")}
              </Button>
              <Button
                type="submit"
                disabled={
                  submitting ||
                  !branchId ||
                  !variantId ||
                  !customer.trim() ||
                  !boards ||
                  !salePrice
                }
              >
                {submitting ? tForm("submitting") : tForm("submit")}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

