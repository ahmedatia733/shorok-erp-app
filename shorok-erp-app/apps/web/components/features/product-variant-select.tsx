"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { filterVariants, variantLabel, type VariantItem } from "../../lib/variant-select";
import { computeDropdownPosition, type DropdownPosition } from "../../lib/dropdown-position";

/**
 * Single searchable product-variant selector (replaces the old الكود / اسم الكود /
 * الصنف columns). The results panel is rendered through a portal into
 * document.body with position:fixed, so table/card/modal overflow can never clip
 * it; it auto-flips up/down, stays inside the viewport, and gives a large
 * scrollable list. Search matches SKU code, Arabic + English name, color, size,
 * category; picking a result stores the exact productVariantId.
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
  renderExtra?: (v: VariantItem) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<DropdownPosition | null>(null);
  const [mounted, setMounted] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => setMounted(true), []);

  const selected = useMemo(() => variants.find((v) => v.id === value) ?? null, [variants, value]);
  const results = useMemo(() => filterVariants(variants, query).slice(0, 200), [variants, query]);

  function reposition() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(computeDropdownPosition({ top: r.top, left: r.left, width: r.width, bottom: r.bottom }, { width: window.innerWidth, height: window.innerHeight }));
  }

  function openMenu() {
    if (disabled) return;
    setQuery("");
    reposition();
    // Highlight (and later scroll to) the current selection when opening.
    setHighlight(selected ? Math.max(0, results.findIndex((v) => v.id === selected.id)) : 0);
    setOpen(true);
  }

  // Reposition on scroll (incl. table horizontal scroll — capture phase) + resize.
  useEffect(() => {
    if (!open) return;
    const onMove = () => reposition();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
      document.removeEventListener("mousedown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlighted row in view.
  useLayoutEffect(() => {
    if (!open) return;
    const li = listRef.current?.children[highlight] as HTMLElement | undefined;
    li?.scrollIntoView({ block: "nearest" });
  }, [highlight, open, results.length]);

  function pick(v: VariantItem) {
    onChange(v.id);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(results.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setHighlight(0); }
    else if (e.key === "End") { e.preventDefault(); setHighlight(Math.max(0, results.length - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const v = results[highlight]; if (v) pick(v); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="w-full border border-border rounded px-2 py-1.5 text-sm text-start bg-background disabled:opacity-60 truncate"
        title={selected ? variantLabel(selected) : placeholder}
      >
        {selected ? <span className="font-medium">{variantLabel(selected)}</span> : <span className="text-textSecondary">{placeholder}</span>}
      </button>

      {mounted && open && pos && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[100] flex flex-col rounded-md border border-border bg-background shadow-2xl"
          style={{
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxHeight,
            ...(pos.placement === "down" ? { top: pos.top } : { bottom: pos.bottom }),
          }}
        >
          <div className="p-2 border-b border-border bg-background rounded-t-md">
            <input
              autoFocus
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
              onKeyDown={onKeyDown}
              placeholder="ابحث بالكود / الاسم / اللون / المقاس"
              className="w-full border border-border rounded px-2 py-1.5 text-sm bg-background"
            />
          </div>
          <ul
            ref={listRef}
            className="overflow-y-auto overscroll-contain py-1"
            style={{ minHeight: results.length ? Math.min(280, Math.max(0, pos.maxHeight - 56)) : undefined }}
          >
            {results.length === 0 ? (
              <li className="px-3 py-3 text-sm text-textSecondary">لا توجد نتائج</li>
            ) : (
              results.map((v, i) => {
                const extra = renderExtra?.(v);
                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => pick(v)}
                      className={
                        "w-full text-start px-3 py-2 min-h-[44px] leading-snug whitespace-normal break-words " +
                        (i === highlight ? "bg-primary/10 " : "hover:bg-surface ") +
                        (v.id === value ? "font-semibold" : "")
                      }
                    >
                      <span className="block text-sm">{variantLabel(v)}</span>
                      {extra ? <span className="block text-xs text-textSecondary mt-0.5">{extra}</span> : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}
