"use client";

import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../../../lib/api-client";
import { formatNumber } from "../../../lib/format";
import {
  getSourceSizeOptions,
  type SourceSizeOption,
} from "../../../lib/inventory-transfers-client";
import { Alert } from "../../ui/alert";

interface Props {
  sourceBranchId: string | null;
  productSkuId: string | null;
  value: string | null;
  onChange: (productVariantId: string | null, option: SourceSizeOption | null) => void;
  locale: "ar" | "en";
}

/**
 * The sizes of one product that actually exist in the chosen source branch.
 *
 * Every card is one exact ProductVariant. «ك», «ص» and «م/خ» are labels printed
 * on top of that variant, never a substitute for it — two custom boards that
 * both read «م/خ» are two cards, because they are two different pieces of
 * stock and one cannot be sent in place of the other.
 *
 * A size that exists for the product but has no stock here is shown greyed out
 * rather than hidden: "not available in this warehouse" is information the
 * storekeeper needs, whereas a missing card just looks like a bug.
 */
export function SourceSizeOptions({ sourceBranchId, productSkuId, value, onChange, locale }: Props) {
  const [options, setOptions] = useState<SourceSizeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Guards against a slow answer for an old branch/product arriving after a
   * newer one and repainting the list. Only the most recent request may write
   * state; anything else is discarded.
   */
  const latest = useRef(0);

  useEffect(() => {
    if (!sourceBranchId || !productSkuId) {
      setOptions([]);
      setError(null);
      setLoading(false);
      return;
    }
    const ticket = ++latest.current;
    const askedBranch = sourceBranchId;
    const askedSku = productSkuId;
    setLoading(true);
    setError(null);

    void getSourceSizeOptions(askedBranch, askedSku)
      .then((res) => {
        if (ticket !== latest.current) return; // a newer request has taken over
        // Belt and braces: the server echoes what it answered about, so a
        // mismatched payload is dropped rather than displayed.
        if (res.sourceBranchId !== askedBranch || res.productSkuId !== askedSku) return;
        setOptions(res.options);
      })
      .catch((e: unknown) => {
        if (ticket !== latest.current) return;
        setOptions([]);
        const detail =
          e instanceof ApiClientError
            ? ((e.payload?.details as { messageAr?: string } | undefined)?.messageAr ?? null)
            : null;
        setError(detail ?? "تعذّر تحميل المقاسات المتاحة.");
      })
      .finally(() => {
        if (ticket === latest.current) setLoading(false);
      });
  }, [sourceBranchId, productSkuId]);

  if (!sourceBranchId) {
    return <p className="text-sm text-textSecondary">اختر المخزن المصدر أولًا.</p>;
  }
  if (!productSkuId) {
    return <p className="text-sm text-textSecondary">اختر الصنف لعرض المقاسات المتاحة.</p>;
  }
  if (loading) {
    return <p className="text-sm text-textSecondary">جارٍ تحميل المقاسات المتاحة...</p>;
  }
  if (error) {
    return <Alert variant="error">{error}</Alert>;
  }
  if (options.length === 0) {
    return (
      <p className="text-sm text-textSecondary">
        لا توجد مقاسات متاحة لهذا الصنف في المخزن المحدد.
      </p>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="اختر المقاس المتاح في المخزن المصدر"
      className="flex flex-wrap gap-2"
      data-testid="source-size-options"
    >
      {options.map((o) => {
        const selected = value === o.productVariantId;
        return (
          <button
            key={o.productVariantId}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={!o.enabled}
            disabled={!o.enabled}
            // Both the reason and the availability are read out, so the state is
            // never conveyed by colour alone.
            aria-label={
              `${o.sizeBadgeAr} — ${o.dimensionsLabelAr}. ` +
              (o.enabled
                ? `متاح في المخزن: ${o.boardsAvailable} لوح، ${o.metersAvailable} متر.`
                : `${o.disabledReasonAr ?? "غير متاح في المخزن المحدد"}.`)
            }
            data-testid={`size-option-${o.productVariantId}`}
            data-enabled={o.enabled ? "true" : "false"}
            data-badge={o.sizeBadge}
            onClick={() => {
              if (!o.enabled) return;
              // Explicit selection every time — never auto-selected, even when
              // only one option is enabled.
              onChange(selected ? null : o.productVariantId, selected ? null : o);
            }}
            className={[
              "min-w-[9.5rem] rounded-md border p-3 text-start transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
              o.enabled
                ? selected
                  ? "border-primary bg-primary/10 text-textPrimary"
                  : "border-border bg-surface hover:border-primary/60"
                : "cursor-not-allowed border-dashed border-border bg-background text-textSecondary opacity-60",
            ].join(" ")}
          >
            <span className="flex items-center gap-2">
              <span className="rounded bg-background px-2 py-0.5 text-sm font-bold">{o.sizeBadgeAr}</span>
              <span className="text-sm font-medium">{o.dimensionsLabelAr}</span>
              {selected && <span className="text-xs text-primary">✓ محدد</span>}
            </span>
            <span className="mt-1 block text-xs">
              {o.enabled ? (
                <>
                  متاح في المخزن: {formatNumber(o.boardsAvailable, locale)} لوح /{" "}
                  {formatNumber(o.metersAvailable, locale)} م
                </>
              ) : (
                <span className="text-warning">{o.disabledReasonAr ?? "غير متاح في المخزن المحدد"}</span>
              )}
            </span>
            {o.sizeBadge === "CUSTOM" && (
              <span className="mt-1 block text-[11px] text-textSecondary">مقاس خاص</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
