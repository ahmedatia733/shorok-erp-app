"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Input } from "../../../../../../components/ui/input";
import { Label } from "../../../../../../components/ui/label";
import { SearchableSelect } from "../../../../../../components/ui/searchable-select";
import { BranchStockSizeOptions } from "../../../../../../components/features/inventory/branch-stock-size-options";
import { ApiClientError } from "../../../../../../lib/api-client";
import {
  projectAdjustment,
  signedBoardDelta,
  type AdjustmentDirection,
} from "../../../../../../lib/adjustment-calc";
import { formatNumber } from "../../../../../../lib/format";
import {
  getBranchStockProducts,
  listBranches,
  postAdjustment,
  type ApplyResult,
  type BranchStockProduct,
  type BranchStockSize,
  type BranchSummary,
} from "../../../../../../lib/inventory-client";

/**
 * تعديل مخزون — settle one exact size in one warehouse.
 *
 * The screen used to offer the entire active catalogue, which meant the two
 * questions that actually decide what gets written — *which warehouse* and
 * *which board size* — were answered by a single dropdown listing sizes that
 * may not exist where the storekeeper is standing. It also accepted fractional
 * boards, so a stray decimal could settle a quarter of a board.
 *
 * It now follows the stock: warehouse → the products that warehouse really
 * holds → that product's sizes with their real boards and metres → whole boards
 * up or down → the resulting balance, shown before anything is written.
 *
 * The posting path is untouched. This is still one `POST /inventory/adjustments`
 * against one ProductVariant, handled by the same engine, which writes a
 * quantity movement and no journal entry — a settlement corrects the count, not
 * the books.
 */
export default function AdjustmentsNewPage() {
  const t = useTranslations("inventory.adjustment");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const params = useSearchParams();

  const [branches, setBranches] = useState<BranchSummary[]>([]);
  // The warehouse the user was already looking at, carried over from the stock
  // screen. It is a continuation of an explicit choice, not a default.
  const [branchId, setBranchId] = useState(params.get("branchId") ?? "");

  const [products, setProducts] = useState<BranchStockProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  /** Discards a slow answer for a warehouse the user has already left. */
  const productsTicket = useRef(0);

  const [productSkuId, setProductSkuId] = useState<string | null>(null);
  const [size, setSize] = useState<BranchStockSize | null>(null);
  const [direction, setDirection] = useState<AdjustmentDirection | null>(null);
  const [boards, setBoards] = useState("");
  const [note, setNote] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);

  useEffect(() => {
    void listBranches().then((rows) => setBranches(rows.filter((b) => b.active)));
  }, []);

  // The catalogue is not the product list here — the warehouse is.
  useEffect(() => {
    if (!branchId) {
      setProducts([]);
      setProductsError(null);
      setProductsLoading(false);
      return;
    }
    const ticket = ++productsTicket.current;
    const asked = branchId;
    setProductsLoading(true);
    setProductsError(null);
    void getBranchStockProducts(asked)
      .then((res) => {
        // Two guards, because an out-of-order response must never repaint the
        // picker with another warehouse's products: the newest request wins,
        // and the payload has to say it is about the warehouse on screen.
        if (ticket !== productsTicket.current || res.branchId !== asked) return;
        setProducts(res.products);
      })
      .catch((e: unknown) => {
        if (ticket !== productsTicket.current) return;
        setProducts([]);
        const detail =
          e instanceof ApiClientError
            ? ((e.payload?.details as { messageAr?: string } | undefined)?.messageAr ?? null)
            : null;
        setProductsError((locale === "ar" ? detail : null) ?? t("productError"));
      })
      .finally(() => {
        if (ticket === productsTicket.current) setProductsLoading(false);
      });
  }, [branchId, locale, t]);

  /**
   * Changing the warehouse invalidates everything below it. A product picked in
   * another warehouse may not be held here at all, and a quantity typed against
   * a size in one warehouse says nothing about this one.
   */
  const changeBranch = (id: string) => {
    setBranchId(id);
    setProductSkuId(null);
    setSize(null);
    setDirection(null);
    setBoards("");
    setError(null);
  };

  /** A different product means different sizes; the old selection cannot stand. */
  const changeProduct = (id: string) => {
    setProductSkuId(id || null);
    setSize(null);
    setDirection(null);
    setBoards("");
    setError(null);
  };

  /** A different size means the count was typed against a different board. */
  const changeSize = (_variantId: string | null, picked: BranchStockSize | null) => {
    setSize(picked);
    setBoards("");
    setError(null);
    // A size holding nothing can only go up, so a decrease chosen a moment ago
    // is no longer a possible answer.
    setDirection((d) => (picked && !picked.hasStock && d === "DECREASE" ? null : d));
  };

  /** The signed, whole-board delta exactly as the API will receive it. */
  const signedDelta = useMemo(() => signedBoardDelta(direction, boards), [direction, boards]);

  /** What the balance becomes, worked out the way the engine works it out. */
  const projection = useMemo(
    () => (size && signedDelta ? projectAdjustment(size, signedDelta) : null),
    [size, signedDelta],
  );

  const selectedProduct = products.find((p) => p.productSkuId === productSkuId) ?? null;
  const selectedBranch = branches.find((b) => b.id === branchId) ?? null;

  const canSubmit =
    Boolean(branchId && size && signedDelta && note.trim()) &&
    projection !== null &&
    !projection.negative &&
    !submitting;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit || !size || !signedDelta) return;
    setSubmitting(true);
    setError(null);
    try {
      const applied = await postAdjustment({
        branchId,
        // The exact variant behind the chosen card — never a sibling size.
        productVariantId: size.productVariantId,
        boardsDelta: signedDelta,
        note: note.trim(),
      });
      setResult(applied);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
      else setError(t("productError"));
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <div className="max-w-xl">
        <Card>
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <Alert variant="success">{t("success")}</Alert>
            <p className="text-sm" data-testid="adjustment-result">
              {t("successBalance", {
                boards: formatNumber(result.boardsOnHand, locale),
                meters: formatNumber(result.metersOnHand, locale),
              })}
            </p>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  // A fresh settlement, not a repeat of the last one: only the
                  // warehouse survives, and the reason must be typed again.
                  setResult(null);
                  setProductSkuId(null);
                  setSize(null);
                  setDirection(null);
                  setBoards("");
                  setNote("");
                }}
              >
                {t("another")}
              </Button>
              <Button type="button" onClick={() => router.push(`/${locale}/inventory?branchId=${branchId}`)}>
                {t("backToInventory")}
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="mb-4 text-sm text-textSecondary">{t("subtitle")}</p>
          {error ? (
            <Alert variant="error" className="mb-3">
              {error}
            </Alert>
          ) : null}

          <form onSubmit={onSubmit} className="space-y-5" noValidate>
            <div>
              <Label htmlFor="adjustment-branch">{t("branch")}</Label>
              <select
                id="adjustment-branch"
                data-testid="adjustment-branch"
                value={branchId}
                onChange={(e) => changeBranch(e.target.value)}
                disabled={submitting}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">{t("branchPlaceholder")}</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {locale === "ar" ? b.nameAr : b.nameEn}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="adjustment-product">{t("product")}</Label>
              {!branchId ? (
                <p className="text-sm text-textSecondary">{t("chooseBranchFirst")}</p>
              ) : productsError ? (
                <p className="text-sm text-danger" data-testid="adjustment-product-error">
                  {productsError}
                </p>
              ) : !productsLoading && products.length === 0 ? (
                <p className="text-sm text-textSecondary" data-testid="adjustment-product-empty">
                  {t("productEmpty")}
                </p>
              ) : (
                <>
                  <SearchableSelect
                    id="adjustment-product"
                    testId="adjustment-product"
                    value={productSkuId ?? ""}
                    onChange={changeProduct}
                    placeholder={t("productPlaceholder")}
                    loading={productsLoading}
                    loadingText={t("productLoading")}
                    emptyText={t("productEmpty")}
                    disabled={submitting}
                    clearable
                    // Search still matches code, Arabic and English name — but
                    // only within what this warehouse actually holds.
                    options={products.map((p) => ({
                      value: p.productSkuId,
                      label: `${p.code} — ${p.nameAr}`,
                      keywords: [p.code, p.nameAr, p.nameEn].filter(Boolean).join(" "),
                    }))}
                  />
                  <p className="mt-1 text-xs text-textSecondary">{t("productHint")}</p>
                </>
              )}
            </div>

            <div>
              <Label>{t("size")}</Label>
              <BranchStockSizeOptions
                branchId={branchId || null}
                productSkuId={productSkuId}
                value={size?.productVariantId ?? null}
                onChange={changeSize}
                locale={locale}
                disabled={submitting}
              />
            </div>

            {size ? (
              <>
                <div>
                  <Label>{t("direction")}</Label>
                  <div role="radiogroup" aria-label={t("direction")} className="flex flex-wrap gap-2">
                    {(["INCREASE", "DECREASE"] as const).map((d) => {
                      // Nothing on hand means nothing to take away; the engine
                      // would refuse it, so the control does not offer it.
                      const blocked = d === "DECREASE" && !size.hasStock;
                      const selected = direction === d;
                      return (
                        <button
                          key={d}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-disabled={blocked}
                          disabled={blocked || submitting}
                          data-testid={`adjustment-direction-${d.toLowerCase()}`}
                          onClick={() => {
                            setDirection(d);
                            setError(null);
                          }}
                          className={[
                            "rounded-md border px-4 py-2 text-sm transition-colors",
                            "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
                            blocked
                              ? "cursor-not-allowed border-dashed border-border bg-background text-textSecondary opacity-60"
                              : selected
                                ? "border-primary bg-primary/10 font-medium text-textPrimary"
                                : "border-border bg-surface hover:border-primary/60",
                          ].join(" ")}
                        >
                          {d === "INCREASE" ? t("increase") : t("decrease")}
                        </button>
                      );
                    })}
                  </div>
                  {!size.hasStock && (
                    <p className="mt-1 text-xs text-textSecondary">{t("decreaseDisabled")}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="adjustment-boards">{t("boards")}</Label>
                  <Input
                    id="adjustment-boards"
                    data-testid="adjustment-boards"
                    dir="ltr"
                    inputMode="numeric"
                    autoComplete="off"
                    value={boards}
                    // Digits only, at the keystroke: stock is counted in whole
                    // boards, so a decimal point is not a value to validate
                    // later — it is a character that never belongs here.
                    onChange={(e) => setBoards(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    disabled={submitting || !direction}
                    placeholder={t("boardsPlaceholder")}
                  />
                  <p className="mt-1 text-xs text-textSecondary">{t("boardsHint")}</p>
                </div>
              </>
            ) : null}

            {size && projection ? (
              <div className="rounded-md border border-border bg-background p-3" data-testid="adjustment-projection">
                <p className="mb-2 text-sm font-medium">{t("projection")}</p>
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-textSecondary">{t("projectionCurrent")}</dt>
                    <dd dir="ltr">
                      {formatNumber(size.boardsOnHand, locale)} {t("unitBoards")} /{" "}
                      {formatNumber(size.metersOnHand, locale)} {t("unitMeters")}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-textSecondary">{t("projectionChange")}</dt>
                    {/* The signed figures exactly as they will be sent — not a
                        prettified version of them. */}
                    <dd dir="ltr" data-testid="adjustment-change">
                      {signedDelta} {t("unitBoards")} / {projection.metersDelta} {t("unitMeters")}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 border-t border-border pt-1 font-medium">
                    <dt>{t("projectionResult")}</dt>
                    <dd dir="ltr" data-testid="adjustment-resulting">
                      {formatNumber(projection.resultingBoards, locale)} {t("unitBoards")} /{" "}
                      {formatNumber(projection.resultingMeters, locale)} {t("unitMeters")}
                    </dd>
                  </div>
                </dl>
                {projection.negative && (
                  <Alert variant="error" className="mt-3">
                    {t("negativeResult")}
                  </Alert>
                )}
              </div>
            ) : null}

            <div>
              <Label htmlFor="adjustment-note">{t("note")}</Label>
              <Input
                id="adjustment-note"
                data-testid="adjustment-note"
                type="text"
                required
                minLength={1}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={submitting}
                placeholder={t("notePlaceholder")}
              />
            </div>

            {size && selectedProduct && selectedBranch ? (
              <p className="text-sm text-textSecondary" data-testid="adjustment-summary">
                {t("summary", {
                  product: `${selectedProduct.code} — ${selectedProduct.nameAr}`,
                  size: locale === "ar" ? size.sizeBadgeAr : size.sizeBadge,
                  branch: locale === "ar" ? selectedBranch.nameAr : selectedBranch.nameEn,
                })}
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-3 pt-2">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                {tCommon("back")}
              </Button>
              <Button type="submit" data-testid="adjustment-submit" disabled={!canSubmit}>
                {submitting ? t("submitting") : t("submit")}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
