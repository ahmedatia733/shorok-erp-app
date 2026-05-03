export const LOCALES = ["ar", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ar";

export const CURRENCY = "EGP";
export const PHONE_DEFAULT_COUNTRY = "EG";
