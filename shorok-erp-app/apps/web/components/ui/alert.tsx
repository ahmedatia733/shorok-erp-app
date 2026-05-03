import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

interface AlertProps {
  variant?: "info" | "error";
  children: ReactNode;
  className?: string;
}

export function Alert({ variant = "info", children, className }: AlertProps) {
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      aria-live={variant === "error" ? "assertive" : "polite"}
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        variant === "error"
          ? "border-red-300 bg-red-50 text-red-900"
          : "border-blue-300 bg-blue-50 text-blue-900",
        className,
      )}
    >
      {children}
    </div>
  );
}
