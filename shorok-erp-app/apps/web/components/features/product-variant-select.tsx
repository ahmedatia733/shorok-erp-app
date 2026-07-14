"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { filterVariants, variantLabel, type VariantItem } from "../../lib/variant-select";

/**
 * Single searchable product-variant selector — the one control that replaces the
 * old separate "الكود / اسم الكود / الصنف" columns. Search matches SKU code,
 * Arabic + English name, color, size and category; picking a result stores the
 * exact productVariantId (never another size/color). Read-only tables/reports
 * keep showing product names elsewhere — this only replaces editable selectors.
 */
export function ProductVariantSelect({
  variants,
  value,
  onChange,
  placeholder = "الكود / الصنف — ابحث بالكود أو الاسم أو اللون أو المقاس",
  disabled = false,
  renderExtra,
}: {
  variants: VariantItem[];
  value: string;
  onChange: (variantId: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** optional trailing info per option (e.g. stock/price) */
  renderExtra?: (v: VariantItem) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => variants.find((v) => v.id === value) ?? null, [variants, value]);
  const results = useMemo(() => filterVariants(variants, query).slice(0, 50), [variants, query]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function pick(v: VariantItem) {
    onChange(v.id);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className="w-full border border-border rounded px-2 py-1.5 text-sm text-start bg-background disabled:opacity-60"
        title={selected ? variantLabel(selected) : placeholder}
      >
        {selected ? (
          <span className="font-medium">{variantLabel(selected)}</span>
        ) : (
          <span className="text-textSecondary">{placeholder}</span>
        )}
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full min-w-[260px] rounded border border-border bg-background shadow-lg">
          <div className="p-1.5 border-b border-border">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ابحث بالكود / الاسم / اللون / المقاس"
              className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {results.length === 0 ? (
              <li className="px-3 py-2 text-xs text-textSecondary">لا توجد نتائج</li>
            ) : (
              results.map((v) => {
                const extra = renderExtra?.(v);
                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => pick(v)}
                      className={
                        "w-full text-start px-3 py-1.5 text-sm hover:bg-surface " +
                        (v.id === value ? "bg-surface font-medium" : "")
                      }
                    >
                      <span>{variantLabel(v)}</span>
                      {extra ? <span className="ms-2 text-xs text-textSecondary">{extra}</span> : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
