import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** Pulsing placeholder used by loading states (per design system). */
export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-md bg-border/70", className)}
      {...rest}
    />
  );
}
