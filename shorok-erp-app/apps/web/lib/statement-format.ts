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
 * Accounting presentation of a signed balance. A negative value is rendered in
 * parentheses — a shape cue that does NOT depend on colour — so the cell stays
 * accessible when the red tone and aria-label it also carries are unavailable.
 * Zero and positive values format plainly.
 */
export function accountingMoney(value: string | number, locale: AppLocale): MoneyParts {
  const n = Number(value);
  const negative = n < 0;
  const text = negative ? `(${money(Math.abs(n), locale)})` : money(n, locale);
  return { text, negative };
}
