import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "neutral" | "success" | "warning" | "danger" | "info";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

const variantClasses: Record<Variant, string> = {
  neutral: "bg-background text-textSecondary border-border",
  success: "bg-success-bg text-success-foreground border-success",
  warning: "bg-warning-bg text-warning-foreground border-warning",
  danger: "bg-danger-bg text-danger-foreground border-danger",
  info: "bg-info-bg text-info-foreground border-info",
};

export function Badge({ variant = "neutral", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className,
      )}
      {...rest}
    />
  );
}
