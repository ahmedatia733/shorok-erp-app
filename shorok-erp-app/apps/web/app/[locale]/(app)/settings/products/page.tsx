"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { Modal } from "../../../../../components/ui/modal";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { ApiClientError } from "../../../../../lib/api-client";
import {
  createSku,
  createVariant,
  listAllVariants,
  listSkus,
  updateSku,
  updateVariant,
  type SkuRow,
  type VariantRow,
} from "../../../../../lib/admin-client";

export default function SettingsProductsPage() {
  const t = useTranslations("settings.products");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;

  const [skus, setSkus] = useState<SkuRow[] | null>(null);
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [listSearch, setListSearch] = useState("");

  // SKU create form
  const [code, setCode] = useState("");
  const [colorAr, setColorAr] = useState("");
  const [colorEn, setColorEn] = useState("");
  const [skuSubmitting, setSkuSubmitting] = useState(false);
  const [skuError, setSkuError] = useState<string | null>(null);

  // Variant create form
  const [variantSku, setVariantSku] = useState<string | null>(null);
  const [size, setSize] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [tolerance, setTolerance] = useState("");
  const [variantSubmitting, setVariantSubmitting] = useState(false);
  const [variantError, setVariantError] = useState<string | null>(null);

  // SKU edit modal
  const [editSku, setEditSku] = useState<SkuRow | null>(null);
  const [editSkuCode, setEditSkuCode] = useState("");
  const [editSkuColorAr, setEditSkuColorAr] = useState("");
  const [editSkuColorEn, setEditSkuColorEn] = useState("");
  const [editSkuLoading, setEditSkuLoading] = useState(false);
  const [editSkuError, setEditSkuError] = useState<string | null>(null);

  // Variant edit modal
  const [editVariant, setEditVariant] = useState<VariantRow | null>(null);
  const [editVSalePrice, setEditVSalePrice] = useState("");
  const [editVPurchasePrice, setEditVPurchasePrice] = useState("");
  const [editVTolerance, setEditVTolerance] = useState("");
  const [editVLoading, setEditVLoading] = useState(false);
  const [editVError, setEditVError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSkus(null);
    void (async () => {
      try {
        const [s, v] = await Promise.all([listSkus(), listAllVariants()]);
        if (!cancelled) {
          setSkus(s);
          setVariants(v);
        }
      } catch {
        if (!cancelled) setError(t("loadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload, t]);

  const variantsBySku = useMemo(() => {
    const map = new Map<string, VariantRow[]>();
    for (const v of variants) {
      const list = map.get(v.skuId) ?? [];
      list.push(v);
      map.set(v.skuId, list);
    }
    return map;
  }, [variants]);

  const onCreateSku = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSkuSubmitting(true);
    setSkuError(null);
    try {
      await createSku({
        code: code.trim(),
        colorNameAr: colorAr.trim(),
        colorNameEn: colorEn.trim(),
      });
      setCode("");
      setColorAr("");
      setColorEn("");
      setReload((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiClientError) setSkuError(err.localizedMessage(locale));
    } finally {
      setSkuSubmitting(false);
    }
  };

  const onCreateVariant = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!variantSku) return;
    setVariantSubmitting(true);
    setVariantError(null);
    try {
      await createVariant({
        skuId: variantSku,
        sizeMetersPerBoard: size.trim(),
        defaultSalePricePerMeter: salePrice.trim(),
        defaultPurchasePricePerMeter: purchasePrice.trim(),
        priceOverrideTolerancePercent: tolerance.trim() || null,
      });
      setSize("");
      setSalePrice("");
      setPurchasePrice("");
      setTolerance("");
      setReload((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiClientError) setVariantError(err.localizedMessage(locale));
    } finally {
      setVariantSubmitting(false);
    }
  };

  const openEditSku = (s: SkuRow) => {
    setEditSku(s);
    setEditSkuCode(s.code);
    setEditSkuColorAr(s.colorNameAr);
    setEditSkuColorEn(s.colorNameEn);
    setEditSkuError(null);
  };

  const onEditSkuSave = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editSku) return;
    setEditSkuLoading(true);
    setEditSkuError(null);
    try {
      const updated = await updateSku(editSku.id, {
        code: editSkuCode.trim(),
        colorNameAr: editSkuColorAr.trim(),
        colorNameEn: editSkuColorEn.trim(),
      });
      setSkus((prev) => prev?.map((s) => (s.id === updated.id ? updated : s)) ?? prev);
      setEditSku(null);
    } catch (err) {
      if (err instanceof ApiClientError) setEditSkuError(err.localizedMessage(locale));
      else setEditSkuError(tCommon("actionFailed"));
    } finally {
      setEditSkuLoading(false);
    }
  };

  const onToggleSkuActive = async (s: SkuRow) => {
    try {
      const updated = await updateSku(s.id, { active: !s.active });
      setSkus((prev) => prev?.map((r) => (r.id === updated.id ? updated : r)) ?? prev);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
    }
  };

  const openEditVariant = (v: VariantRow) => {
    setEditVariant(v);
    setEditVSalePrice(v.defaultSalePricePerMeter);
    setEditVPurchasePrice(v.defaultPurchasePricePerMeter);
    setEditVTolerance(v.priceOverrideTolerancePercent ?? "");
    setEditVError(null);
  };

  const onEditVariantSave = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editVariant) return;
    setEditVLoading(true);
    setEditVError(null);
    try {
      const updated = await updateVariant(editVariant.id, {
        defaultSalePricePerMeter: editVSalePrice.trim(),
        defaultPurchasePricePerMeter: editVPurchasePrice.trim(),
        priceOverrideTolerancePercent: editVTolerance.trim() || null,
      });
      setVariants((prev) => prev.map((v) => (v.id === updated.id ? updated : v)));
      setEditVariant(null);
    } catch (err) {
      if (err instanceof ApiClientError) setEditVError(err.localizedMessage(locale));
      else setEditVError(tCommon("actionFailed"));
    } finally {
      setEditVLoading(false);
    }
  };

  const onToggleVariantActive = async (v: VariantRow) => {
    try {
      const updated = await updateVariant(v.id, { active: !v.active });
      setVariants((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("createSku")}</CardTitle>
        </CardHeader>
        <CardBody>
          {skuError ? (
            <Alert variant="error" className="mb-3">
              {skuError}
            </Alert>
          ) : null}
          <form onSubmit={onCreateSku} className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <Label htmlFor="code">{t("code")}</Label>
              <Input
                id="code"
                required
                dir="ltr"
                maxLength={60}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={skuSubmitting}
              />
            </div>
            <div>
              <Label htmlFor="colorAr">{t("colorAr")}</Label>
              <Input
                id="colorAr"
                required
                maxLength={120}
                value={colorAr}
                onChange={(e) => setColorAr(e.target.value)}
                disabled={skuSubmitting}
              />
            </div>
            <div>
              <Label htmlFor="colorEn">{t("colorEn")}</Label>
              <Input
                id="colorEn"
                required
                dir="ltr"
                maxLength={120}
                value={colorEn}
                onChange={(e) => setColorEn(e.target.value)}
                disabled={skuSubmitting}
              />
            </div>
            <div className="md:col-span-3">
              <Button
                type="submit"
                disabled={
                  skuSubmitting || !code.trim() || !colorAr.trim() || !colorEn.trim()
                }
              >
                {skuSubmitting ? tCommon("loading") : tCommon("save")}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("createVariant")}</CardTitle>
        </CardHeader>
        <CardBody>
          {variantError ? (
            <Alert variant="error" className="mb-3">
              {variantError}
            </Alert>
          ) : null}
          <form onSubmit={onCreateVariant} className="grid grid-cols-1 gap-3 md:grid-cols-5">
            <div>
              <Label htmlFor="variantSku">{t("sku")}</Label>
              <select
                id="variantSku"
                value={variantSku ?? ""}
                onChange={(e) => setVariantSku(e.target.value || null)}
                disabled={variantSubmitting || !skus}
                className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="" disabled>
                  —
                </option>
                {skus?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {locale === "ar" ? s.colorNameAr : s.colorNameEn}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="size">{t("size")}</Label>
              <Input
                id="size"
                type="number"
                step="0.0001"
                min="0.0001"
                dir="ltr"
                required
                value={size}
                onChange={(e) => setSize(e.target.value)}
                disabled={variantSubmitting}
              />
            </div>
            <div>
              <Label htmlFor="salePrice">{t("salePrice")}</Label>
              <Input
                id="salePrice"
                type="number"
                step="0.01"
                min="0.01"
                dir="ltr"
                required
                value={salePrice}
                onChange={(e) => setSalePrice(e.target.value)}
                disabled={variantSubmitting}
              />
            </div>
            <div>
              <Label htmlFor="purchasePrice">{t("purchasePrice")}</Label>
              <Input
                id="purchasePrice"
                type="number"
                step="0.01"
                min="0.01"
                dir="ltr"
                required
                value={purchasePrice}
                onChange={(e) => setPurchasePrice(e.target.value)}
                disabled={variantSubmitting}
              />
            </div>
            <div>
              <Label htmlFor="tolerance">{t("tolerance")}</Label>
              <Input
                id="tolerance"
                type="number"
                step="0.01"
                min="0"
                dir="ltr"
                placeholder="5.00"
                value={tolerance}
                onChange={(e) => setTolerance(e.target.value)}
                disabled={variantSubmitting}
              />
            </div>
            <div className="md:col-span-5">
              <Button
                type="submit"
                disabled={
                  variantSubmitting ||
                  !variantSku ||
                  !size.trim() ||
                  !salePrice.trim() ||
                  !purchasePrice.trim()
                }
              >
                {variantSubmitting ? tCommon("loading") : tCommon("save")}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <div className="flex items-center gap-2">
            <Input placeholder="بحث..." value={listSearch} onChange={(e) => setListSearch(e.target.value)} className="max-w-xs" />
            {listSearch && <button type="button" className="text-xs text-textSecondary hover:text-text" onClick={() => setListSearch("")}>مسح ✕</button>}
          </div>
        </CardHeader>
        <CardBody>
          {skus === null ? (
            <Skeleton className="h-10" />
          ) : (
            <div className="space-y-4">
              {(listSearch ? skus.filter((s) => (s.code + " " + s.colorNameAr + " " + (s.colorNameEn ?? "")).toLowerCase().includes(listSearch.toLowerCase())) : skus).map((s) => {
                const vs = variantsBySku.get(s.id) ?? [];
                return (
                  <div key={s.id} className="rounded-md border border-border p-3">
                    <div className="mb-2 flex items-center gap-2 flex-wrap">
                      <span className="font-medium" dir="ltr">
                        {s.code}
                      </span>
                      <span className="text-textSecondary">
                        · {locale === "ar" ? s.colorNameAr : s.colorNameEn}
                      </span>
                      <Badge variant={s.active ? "success" : "neutral"}>
                        {s.active ? t("active") : t("archived")}
                      </Badge>
                      <div className="ms-auto flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => openEditSku(s)}>
                          {tCommon("edit")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void onToggleSkuActive(s)}
                        >
                          {s.active ? t("archive") : t("restore")}
                        </Button>
                      </div>
                    </div>
                    {vs.length === 0 ? (
                      <div className="text-sm text-textSecondary">{t("noVariants")}</div>
                    ) : (
                      <Table>
                        <THead>
                          <TR>
                            <TH>{t("size")}</TH>
                            <TH>{t("salePrice")}</TH>
                            <TH>{t("purchasePrice")}</TH>
                            <TH>{t("tolerance")}</TH>
                            <TH>{t("status")}</TH>
                            <TH>{tCommon("actions")}</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {vs.map((v) => (
                            <TR key={v.id}>
                              <TD dir="ltr">{v.sizeMetersPerBoard}</TD>
                              <TD dir="ltr">{v.defaultSalePricePerMeter}</TD>
                              <TD dir="ltr">{v.defaultPurchasePricePerMeter}</TD>
                              <TD dir="ltr">{v.priceOverrideTolerancePercent ?? "—"}</TD>
                              <TD>
                                <Badge variant={v.active ? "success" : "neutral"}>
                                  {v.active ? t("active") : t("archived")}
                                </Badge>
                              </TD>
                              <TD>
                                <div className="flex gap-2">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => openEditVariant(v)}
                                  >
                                    {tCommon("edit")}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => void onToggleVariantActive(v)}
                                  >
                                    {v.active ? t("archive") : t("restore")}
                                  </Button>
                                </div>
                              </TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Edit SKU modal */}
      <Modal
        open={editSku !== null}
        onClose={() => setEditSku(null)}
        title={t("editSkuTitle")}
      >
        <form onSubmit={onEditSkuSave} className="space-y-3">
          {editSkuError ? <Alert variant="error">{editSkuError}</Alert> : null}
          <div>
            <Label htmlFor="editSkuCode">{t("code")}</Label>
            <Input
              id="editSkuCode"
              required
              dir="ltr"
              maxLength={60}
              value={editSkuCode}
              onChange={(e) => setEditSkuCode(e.target.value)}
              disabled={editSkuLoading}
            />
          </div>
          <div>
            <Label htmlFor="editSkuColorAr">{t("colorAr")}</Label>
            <Input
              id="editSkuColorAr"
              required
              maxLength={120}
              value={editSkuColorAr}
              onChange={(e) => setEditSkuColorAr(e.target.value)}
              disabled={editSkuLoading}
            />
          </div>
          <div>
            <Label htmlFor="editSkuColorEn">{t("colorEn")}</Label>
            <Input
              id="editSkuColorEn"
              required
              dir="ltr"
              maxLength={120}
              value={editSkuColorEn}
              onChange={(e) => setEditSkuColorEn(e.target.value)}
              disabled={editSkuLoading}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setEditSku(null)} disabled={editSkuLoading}>
              {tCommon("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                editSkuLoading ||
                !editSkuCode.trim() ||
                !editSkuColorAr.trim() ||
                !editSkuColorEn.trim()
              }
            >
              {editSkuLoading ? tCommon("loading") : tCommon("save")}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit Variant modal */}
      <Modal
        open={editVariant !== null}
        onClose={() => setEditVariant(null)}
        title={t("editVariantTitle")}
      >
        <form onSubmit={onEditVariantSave} className="space-y-3">
          {editVError ? <Alert variant="error">{editVError}</Alert> : null}
          <div>
            <Label htmlFor="editVSalePrice">{t("salePrice")}</Label>
            <Input
              id="editVSalePrice"
              type="number"
              step="0.01"
              min="0.01"
              dir="ltr"
              required
              value={editVSalePrice}
              onChange={(e) => setEditVSalePrice(e.target.value)}
              disabled={editVLoading}
            />
          </div>
          <div>
            <Label htmlFor="editVPurchasePrice">{t("purchasePrice")}</Label>
            <Input
              id="editVPurchasePrice"
              type="number"
              step="0.01"
              min="0.01"
              dir="ltr"
              required
              value={editVPurchasePrice}
              onChange={(e) => setEditVPurchasePrice(e.target.value)}
              disabled={editVLoading}
            />
          </div>
          <div>
            <Label htmlFor="editVTolerance">{t("tolerance")}</Label>
            <Input
              id="editVTolerance"
              type="number"
              step="0.01"
              min="0"
              dir="ltr"
              placeholder="5.00"
              value={editVTolerance}
              onChange={(e) => setEditVTolerance(e.target.value)}
              disabled={editVLoading}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setEditVariant(null)} disabled={editVLoading}>
              {tCommon("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                editVLoading || !editVSalePrice.trim() || !editVPurchasePrice.trim()
              }
            >
              {editVLoading ? tCommon("loading") : tCommon("save")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
