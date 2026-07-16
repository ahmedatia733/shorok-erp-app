"use client";

import { apiDownload } from "./api-client";

/**
 * Fetches an invoice PDF from the API and triggers a browser download. Returns
 * once the file has been handed to the browser. Throws ApiClientError on failure
 * so callers can surface a localized message.
 */
export async function downloadInvoicePdf(
  kind: "sales" | "purchase",
  id: string,
  fallbackName: string,
): Promise<void> {
  const path = kind === "sales" ? `/sales-invoices/${id}/pdf` : `/purchase-invoices/${id}/pdf`;
  const { blob, filename } = await apiDownload(path);

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
