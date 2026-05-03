import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type Variant = "info" | "error" | "warning" | "success";

interface AlertProps {
  variant?: Variant;
  children: ReactNode;
  className?: string;
}

const variantClasses: Record<Variant, string> = {
  info: "border-info bg-info-bg text-info-foreground",
  error: "border-danger bg-danger-bg text-danger-foreground",
  warning: "border-warning bg-warning-bg text-warning-foreground",
  success: "border-success bg-success-bg text-success-foreground",
};

export function Alert({ variant = "info", children, className }: AlertProps) {
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      aria-live={variant === "error" ? "assertive" : "polite"}
      className={cn("rounded-md border px-3 py-2 text-sm", variantClasses[variant], className)}
    >
      {children}
    </div>
  );
}
