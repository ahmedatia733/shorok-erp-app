"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { AppLocale } from "../../../i18n";
import { ApiClientError } from "../../../lib/api-client";
import { formatNumber } from "../../../lib/format";
import { getBranchStockSizes, type BranchStockSize } from "../../../lib/inventory-client";
import { Alert } from "../../ui/alert";

interface Props {
  branchId: string | null;
  productSkuId: string | null;
  value: string | null;
  onChange: (productVariantId: string | null, size: BranchStockSize | null) => void;
  locale: AppLocale;
  disabled?: boolean;
}

/**
 * The sizes of one product as they stand in one warehouse, for a settlement.
 *
 * Every card is one exact ProductVariant and carries that warehouse's real
 * boards and metres for it. «ك», «ص» and «م/خ» are labels printed on top of a
 * variant, never a substitute for one — two custom boards that both read «م/خ»
 * are two cards, because they are two different piles of stock and correcting
 * one must never touch the other.
 *
 * A size sitting at zero stays selectable and says so, since recording stock the
 * system does not yet know about is the reason settlements exist. A discontinued
 * size, or one whose boards and metres contradict each other, is shown disabled
 * with the reason: hiding it would read as a bug, and offering it would promise
 * a correction this screen cannot actually make.
 */
export function BranchStockSizeOptions({
  branchId,
  productSkuId,
  value,
  onChange,
  locale,
  disabled = false,
}: Props) {
  const t = useTranslations("inventory.adjustment");
  const [sizes, setSizes] = useState<BranchStockSize[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Guards against a slow answer for an old branch/product arriving after a
   * newer one and repainting the list. Only the most recent request may write
   * state; anything else is discarded.
   */
  const latest = useRef(0);

  useEffect(() => {
    if (!branchId || !productSkuId) {
      setSizes([]);
      setError(null);
      setLoading(false);
      return;
    }
    const ticket = ++latest.current;
    const askedBranch = branchId;
    const askedSku = productSkuId;
    setLoading(true);
    setError(null);

    void getBranchStockSizes(askedBranch, askedSku)
      .then((res) => {
        if (ticket !== latest.current) return; // a newer request has taken over
        // Belt and braces: the server echoes what it answered about, so a
        // mismatched payload is dropped rather than shown as this warehouse's.
        if (res.branchId !== askedBranch || res.productSkuId !== askedSku) return;
        setSizes(res.sizes);
      })
      .catch((e: unknown) => {
        if (ticket !== latest.current) return;
        setSizes([]);
        const detail =
          e instanceof ApiClientError
            ? ((e.payload?.details as { messageAr?: string } | undefined)?.messageAr ?? null)
            : null;
        setError(locale === "ar" ? (detail ?? t("sizeError")) : t("sizeError"));
      })
      .finally(() => {
        if (ticket === latest.current) setLoading(false);
      });
  }, [branchId, productSkuId, locale, t]);

  if (!branchId) return <p className="text-sm text-textSecondary">{t("chooseBranchFirst")}</p>;
  if (!productSkuId) return <p className="text-sm text-textSecondary">{t("sizeChooseProduct")}</p>;
  if (loading) return <p className="text-sm text-textSecondary">{t("sizeLoading")}</p>;
  if (error) return <Alert variant="error">{error}</Alert>;
  if (sizes.length === 0) return <p className="text-sm text-textSecondary">{t("sizeEmpty")}</p>;

  return (
    <div
      role="radiogroup"
      aria-label={t("sizeGroupLabel")}
      className="flex flex-wrap gap-2"
      data-testid="branch-stock-size-options"
    >
      {sizes.map((s) => {
        const selected = value === s.productVariantId;
        const boards = formatNumber(s.boardsOnHand, locale);
        const meters = formatNumber(s.metersOnHand, locale);
        const badge = locale === "ar" ? s.sizeBadgeAr : s.sizeBadge;
        return (
          <button
            key={s.productVariantId}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={!s.adjustable}
            disabled={!s.adjustable || disabled}
            // Both the stock and the reason are read out, so nothing about the
            // state of a card is conveyed by colour alone.
            aria-label={
              `${badge} — ${s.dimensionsLabelAr}. ` +
              (!s.adjustable
                ? `${s.blockedReasonAr ?? t("sizeBlocked")}.`
                : s.hasStock
                  ? t("sizeOnHandSpoken", { boards, meters })
                  : t("sizeNoStockSpoken"))
            }
            data-testid={`stock-size-option-${s.productVariantId}`}
            data-adjustable={s.adjustable ? "true" : "false"}
            data-has-stock={s.hasStock ? "true" : "false"}
            data-badge={s.sizeBadge}
            onClick={() => {
              if (!s.adjustable) return;
              // Explicit selection every time — never auto-selected, even when
              // only one size is adjustable.
              onChange(selected ? null : s.productVariantId, selected ? null : s);
            }}
            className={[
              "min-w-[10.5rem] rounded-md border p-3 text-start transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
              s.adjustable
                ? selected
                  ? "border-primary bg-primary/10 text-textPrimary"
                  : "border-border bg-surface hover:border-primary/60"
                : "cursor-not-allowed border-dashed border-border bg-background text-textSecondary opacity-60",
            ].join(" ")}
          >
            <span className="flex items-center gap-2">
              <span className="rounded bg-background px-2 py-0.5 text-sm font-bold">{badge}</span>
              <span className="text-sm font-medium">{s.dimensionsLabelAr}</span>
              {selected && <span className="text-xs text-primary">{t("sizeSelected")}</span>}
            </span>
            <span className="mt-1 block text-xs">
              {!s.adjustable ? (
                <span className="text-warning">{s.blockedReasonAr ?? t("sizeBlocked")}</span>
              ) : s.hasStock ? (
                t("sizeOnHand", { boards, meters })
              ) : (
                <span className="text-textSecondary">{t("sizeNoStock")}</span>
              )}
            </span>
            {s.sizeBadge === "CUSTOM" && (
              <span className="mt-1 block text-[11px] text-textSecondary">{t("sizeCustom")}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
