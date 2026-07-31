"use client";

import { apiDownload } from "./api-client";
import type { AppLocale } from "../i18n";

/**
 * Fetches a sales/purchase RETURN PDF from the API and triggers a browser
 * download. Uses the centralized `apiDownload` client (auth + refresh + filename
 * parsing). The locale is sent both as a query param and accept-language so the
 * PDF renders RTL/ar or LTR/en. Throws ApiClientError on failure so callers can
 * show a localized message. Works in Safari and Chromium.
 */
export async function downloadReturnPdf(
  kind: "sales" | "purchase",
  id: string,
  locale: AppLocale,
  fallbackName: string,
): Promise<void> {
  const base = kind === "sales" ? "sales-returns" : "purchase-returns";
  const { blob, filename } = await apiDownload(`/${base}/${id}/pdf?locale=${locale}`, { locale });

  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename ?? `${fallbackName}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick so the download has a chance to start.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
