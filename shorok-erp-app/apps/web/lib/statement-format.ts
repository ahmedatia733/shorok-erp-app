import type { AppLocale } from "../i18n";
import { money } from "./treasury-format";

// Reuse the ERP's single locale-aware money formatter (ar → ar-EG Arabic-Indic
// digits, en → en-US Latin digits, always two decimals). No second formatter is
// introduced for the statement.
export { money };

export interface MoneyParts {
  /** Locale-formatted magnitude; negatives are wrapped in parentheses. */
  text: string;
  negative: boolean;
}

/**
 * Adaptive money for the statement: drops the fraction ONLY when it is exactly
 * zero piasters (12,380.00 → 12,380), and keeps real piasters otherwise
 * (12,380.50 → 12,380.50). It is display-only — the value is never rounded or
 * changed. Locale digit style is preserved (ar → ar-EG Arabic-Indic, en →
 * en-US Latin). Invalid input falls back to the two-decimal formatter, matching
 * the previous behaviour.
 */
export function adaptiveMoney(value: string | number, locale: AppLocale): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return money(value, locale);
  // Round to piasters first so binary float noise (e.g. 1000.1 * 100) can't
  // mis-classify a whole amount as fractional.
  const hasPiasters = Math.round(Math.abs(n) * 100) % 100 !== 0;
  return n.toLocaleString(locale === "en" ? "en-US" : "ar-EG",
    hasPiasters
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * Accounting presentation of a signed balance. A negative value is rendered in
 * parentheses — a shape cue that does NOT depend on colour — so the cell stays
 * accessible when the red tone and aria-label it also carries are unavailable.
 * Zero and positive values format plainly. Uses {@link adaptiveMoney} so whole
 * amounts show no trailing .00 while real piasters are preserved.
 */
export function accountingMoney(value: string | number, locale: AppLocale): MoneyParts {
  const n = Number(value);
  const negative = n < 0;
  const text = negative ? `(${adaptiveMoney(Math.abs(n), locale)})` : adaptiveMoney(n, locale);
  return { text, negative };
}
