import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

/**
 * Empty-state placeholder per the design system: clear icon / title / body /
 * action. Messages MUST come from translation keys; this component never
 * renders a default English fallback.
 */
export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-12 px-4",
        className,
      )}
    >
      {icon ? <div className="mb-3 text-textSecondary">{icon}</div> : null}
      <h3 className="text-section-title text-textPrimary mb-1">{title}</h3>
      {description ? <p className="text-sm text-textSecondary mb-4">{description}</p> : null}
      {action}
    </div>
  );
}
