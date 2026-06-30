"use client";

import { useEffect, type ReactNode } from "react";
import { cn } from "../../lib/cn";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, className }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "w-full max-w-md rounded-lg border border-border bg-surface shadow-xl flex flex-col max-h-[90vh]",
          className,
        )}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
            <h2 className="font-semibold text-textPrimary">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-textSecondary hover:text-textPrimary text-lg leading-none"
              aria-label="close"
            >
              ×
            </button>
          </div>
        )}
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
