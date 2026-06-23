import type { AppLocale } from "../i18n";

const CURRENCY = "EGP";

export function formatCurrency(value: number | string, locale: AppLocale): string {
  const num = typeof value === "string" ? Number(value) : value;
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en-US", {
    style: "currency",
    currency: CURRENCY,
    minimumFractionDigits: 2,
  }).format(num);
}

export function formatNumber(value: number | string, locale: AppLocale): string {
  const num = typeof value === "string" ? Number(value) : value;
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en-US").format(num);
}

export function formatDate(value: Date | string, locale: AppLocale): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    calendar: "gregory",
  }).format(d);
}

export function formatDateTime(value: Date | string, locale: AppLocale): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    calendar: "gregory",
  }).format(d);
}
