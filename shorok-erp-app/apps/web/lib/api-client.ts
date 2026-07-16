/**
 * Typed fetch wrapper for the Shorok API.
 *
 * The wrapper:
 *  - prefixes all paths with NEXT_PUBLIC_API_BASE_URL
 *  - attaches an Authorization bearer header from the in-memory access token
 *  - sends credentials so the httpOnly refresh cookie travels with /auth/refresh
 *  - on 401, transparently calls /auth/refresh once and retries the request
 *  - surfaces the localized server message ({code, message_ar, message_en, details?})
 */
import type { AppLocale } from "../i18n";

// Relative URL — Next.js rewrites /api/v1/* → the real API (see next.config.mjs).
// Works in both local dev and production without any build-time env baking.
const API_BASE = "/api/v1";

export interface ApiErrorPayload {
  code: string;
  message_ar: string;
  message_en: string;
  details?: Record<string, unknown>;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: ApiErrorPayload,
  ) {
    super(payload.message_en || payload.code);
    this.name = "ApiClientError";
  }
  localizedMessage(locale: AppLocale): string {
    return locale === "ar" ? this.payload.message_ar : this.payload.message_en;
  }
}

let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}

interface CallOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  locale?: AppLocale;
  /** Set false to skip the auto-refresh on 401 (used for the refresh call itself). */
  retryOnUnauthorized?: boolean;
  signal?: AbortSignal;
}

export async function apiCall<T = unknown>(path: string, options: CallOptions = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "accept-language": options.locale ?? "ar",
  };
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;

  const res = await fetch(url, {
    method: options.method ?? "GET",
    credentials: "include",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (res.status === 401 && options.retryOnUnauthorized !== false && path !== "/auth/refresh") {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return apiCall<T>(path, { ...options, retryOnUnauthorized: false });
    }
  }

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as ApiErrorPayload | null;
    throw new ApiClientError(res.status, payload ?? {
      code: "unknown",
      message_ar: "حدث خطأ غير متوقع.",
      message_en: "An unexpected error occurred.",
    });
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Downloads a binary response (e.g. a PDF) with the same auth + one-shot 401
 * refresh behaviour as {@link apiCall}. Returns the response body as a Blob plus
 * the server-provided filename (from Content-Disposition). Throws ApiClientError
 * on non-2xx, decoding the JSON error envelope the API returns for failures.
 */
export async function apiDownload(
  path: string,
  options: { locale?: AppLocale; retryOnUnauthorized?: boolean; signal?: AbortSignal } = {},
): Promise<{ blob: Blob; filename: string | null }> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const headers: Record<string, string> = { "accept-language": options.locale ?? "ar" };
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;

  const res = await fetch(url, { method: "GET", credentials: "include", headers, signal: options.signal });

  if (res.status === 401 && options.retryOnUnauthorized !== false) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return apiDownload(path, { ...options, retryOnUnauthorized: false });
  }

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as ApiErrorPayload | null;
    throw new ApiClientError(res.status, payload ?? {
      code: "unknown",
      message_ar: "حدث خطأ غير متوقع.",
      message_en: "An unexpected error occurred.",
    });
  }

  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const raw = match?.[1];
  const filename = raw ? decodeURIComponent(raw.replace(/"$/, "")) : null;
  return { blob: await res.blob(), filename };
}

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const data = await apiCall<{ accessToken: string }>("/auth/refresh", {
        method: "POST",
        retryOnUnauthorized: false,
      });
      setAccessToken(data.accessToken);
      return data.accessToken;
    } catch {
      setAccessToken(null);
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function loginWithPhone(phone: string, password: string, locale: AppLocale) {
  const data = await apiCall<{ accessToken: string; expiresInSec: number }>("/auth/login", {
    method: "POST",
    body: { phone, password },
    locale,
    retryOnUnauthorized: false,
  });
  setAccessToken(data.accessToken);
  return data;
}

export async function logout() {
  try {
    await apiCall("/auth/logout", { method: "POST" });
  } finally {
    setAccessToken(null);
  }
}
