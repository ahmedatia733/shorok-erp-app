"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { filterOptions, type SearchableOption } from "../../lib/searchable-filter";

export { filterOptions };
export type { SearchableOption };

/**
 * Single-select combobox with type-ahead search and keyboard navigation.
 *
 * - Opens on click/focus and shows ALL options immediately (empty search).
 * - The input doubles as the search field; matches label + `keywords`, so an
 *   option is findable by code, Arabic name, English name and phone at once.
 * - The dropdown is rendered in a PORTAL with fixed positioning, so it is never
 *   clipped by a modal/table `overflow` and always paints above them.
 * - Keyboard: ArrowUp/Down, Enter to select, Escape to close.
 * - RTL/LTR aware (inherits direction from the trigger); localized placeholder /
 *   empty / loading text via props (no hard-coded strings baked in).
 */
export function SearchableSelect({
  id,
  value,
  onChange,
  options,
  placeholder = "— اختر —",
  loading = false,
  loadingText = "جارِ التحميل...",
  emptyText = "لا توجد نتائج",
  disabled = false,
  clearable = false,
  testId,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SearchableOption[];
  placeholder?: string;
  loading?: boolean;
  loadingText?: string;
  emptyText?: string;
  disabled?: boolean;
  clearable?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; below: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => setMounted(true), []);

  const selected = options.find((o) => o.value === value) ?? null;

  const visible = useMemo(() => filterOptions(options, query), [options, query]);

  // Position the portalled dropdown against the trigger; flip above when there's
  // more room up than down. Recompute on open, scroll and resize.
  const reposition = () => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const below = spaceBelow > 240 || spaceBelow > r.top;
    setRect({ top: below ? r.bottom + 2 : r.top - 2, left: r.left, width: r.width, below });
  };
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on outside click (accounting for the portalled list).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // While open, intercept Escape in the CAPTURE phase (before a surrounding
  // modal's document-level bubble listener) so Escape closes ONLY the dropdown,
  // never the modal.
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      setQuery("");
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  useEffect(() => setActive(0), [query, open]);

  function commit(v: string) {
    onChange(v);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      setActive((i) => Math.min(i + 1, visible.length - 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setActive((i) => Math.max(i - 1, 0));
      e.preventDefault();
    } else if (e.key === "Enter") {
      const opt = visible[active];
      if (opt) commit(opt.value);
      e.preventDefault();
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
      e.preventDefault();
      // Only close the dropdown — don't let Escape bubble to a surrounding modal
      // (which would otherwise close the whole modal).
      e.stopPropagation();
    }
  }

  const inputCls =
    "w-full border border-border rounded px-2 py-1.5 text-sm bg-background disabled:opacity-60 disabled:cursor-not-allowed " +
    (clearable && selected ? "pe-7" : "");

  const list = open && mounted && rect
    ? createPortal(
        <ul
          id={id ? `${id}-listbox` : undefined}
          role="listbox"
          ref={listRef}
          data-testid={testId ? `${testId}-listbox` : undefined}
          style={{
            position: "fixed",
            top: rect.below ? rect.top : undefined,
            bottom: rect.below ? undefined : window.innerHeight - rect.top,
            left: rect.left,
            width: rect.width,
            zIndex: 9999,
          }}
          className="max-h-60 overflow-y-auto rounded border border-border bg-background shadow-lg"
        >
          {loading && <li className="px-3 py-2 text-sm text-textSecondary">{loadingText}</li>}
          {!loading && visible.length === 0 && (
            <li className="px-3 py-2 text-sm text-textSecondary">{emptyText}</li>
          )}
          {!loading &&
            visible.map((o, i) => (
              <li
                key={o.value}
                data-idx={i}
                role="option"
                aria-selected={o.value === value}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(o.value);
                }}
                className={
                  "cursor-pointer px-3 py-1.5 text-sm " +
                  (i === active ? "bg-primary/10 " : "") +
                  (o.value === value ? "font-semibold " : "") +
                  (o.pinned ? "border-b border-border text-primary" : "")
                }
              >
                {o.label}
              </li>
            ))}
        </ul>,
        document.body,
      )
    : null;

  return (
    <div className="relative" ref={rootRef}>
      <input
        id={id}
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={id ? `${id}-listbox` : undefined}
        autoComplete="off"
        disabled={disabled || loading}
        data-testid={testId}
        className={inputCls}
        placeholder={loading ? loadingText : placeholder}
        value={open ? query : selected?.label ?? ""}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => !disabled && !loading && setOpen(true)}
        onClick={() => !disabled && !loading && setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {clearable && selected && !disabled && !loading && (
        <button
          type="button"
          aria-label="clear"
          data-testid={testId ? `${testId}-clear` : undefined}
          className="absolute inset-y-0 end-1 my-auto h-5 w-5 rounded text-textSecondary hover:text-danger text-xs leading-none"
          onMouseDown={(e) => { e.preventDefault(); onChange(""); setQuery(""); }}
        >
          ✕
        </button>
      )}
      {list}
    </div>
  );
}
