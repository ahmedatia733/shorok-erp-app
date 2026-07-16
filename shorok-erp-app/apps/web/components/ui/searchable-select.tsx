"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface SearchableOption {
  value: string;
  label: string;
  /** Extra text matched while searching (code, English name, …). */
  keywords?: string;
  /** Renders as a pinned, visually distinct entry (used for the "الكل" option). */
  pinned?: boolean;
}

/**
 * Single-select with type-ahead search and keyboard navigation.
 *
 * Search matches the label plus `keywords`, so callers can make an option
 * findable by account code, Arabic name and English name at once.
 */
export function SearchableSelect({
  id,
  value,
  onChange,
  options,
  placeholder = "— اختر —",
  loading = false,
  emptyText = "لا توجد نتائج",
  disabled = false,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SearchableOption[];
  placeholder?: string;
  loading?: boolean;
  emptyText?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.keywords ?? ""}`.toLowerCase().includes(q));
  }, [options, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the active option in view while arrowing through a long list.
  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

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
    }
  }

  const inputCls =
    "w-full border border-border rounded px-2 py-1.5 text-sm bg-background disabled:opacity-60 disabled:cursor-not-allowed";

  return (
    <div className="relative" ref={rootRef}>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={id ? `${id}-listbox` : undefined}
        autoComplete="off"
        disabled={disabled || loading}
        className={inputCls}
        placeholder={loading ? "جارِ التحميل..." : placeholder}
        // Show the search text while typing, the selection otherwise.
        value={open ? query : selected?.label ?? ""}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => !disabled && !loading && setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {open && (
        <ul
          id={id ? `${id}-listbox` : undefined}
          role="listbox"
          ref={listRef}
          className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded border border-border bg-background shadow-lg"
        >
          {visible.length === 0 && (
            <li className="px-3 py-2 text-sm text-textSecondary">{emptyText}</li>
          )}
          {visible.map((o, i) => (
            <li
              key={o.value}
              data-idx={i}
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setActive(i)}
              // mousedown, not click: the input's blur would close the list first.
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
        </ul>
      )}
    </div>
  );
}
