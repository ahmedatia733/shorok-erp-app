"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AuditLog, AuditAction } from "@shorok/shared";
import type { AppLocale } from "../../../i18n";
import { Card, CardBody, CardHeader, CardTitle } from "../../ui/card";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { EmptyState } from "../../ui/empty-state";
import { Skeleton } from "../../ui/skeleton";
import { Alert } from "../../ui/alert";
import { ApiClientError, apiCall } from "../../../lib/api-client";
import { formatDateTime } from "../../../lib/format";

interface AuditTailProps {
  entityType: string;
  entityId: string;
  /** Title rendered in the card header. Pass already-localized text. */
  title?: string;
  /** Page size; default 20. */
  pageSize?: number;
}

interface PageResponse {
  data: AuditLog[];
  nextCursor: string | null;
}

const actionVariant: Record<AuditAction, "neutral" | "success" | "warning" | "danger" | "info"> = {
  CREATE: "info",
  UPDATE: "neutral",
  DELETE: "danger",
  CONFIRM: "success",
  CANCEL: "danger",
  APPROVE: "success",
  COLLECT: "success",
  IMPORT: "info",
  LOGIN: "neutral",
  LOGOUT: "neutral",
};

/**
 * Inline timeline of audit-log rows for a single (entityType, entityId).
 * Renders the localized summary that the API stored at write time — the
 * component does NOT translate; the active locale just selects which
 * pre-localized field to show.
 */
export function AuditTail({ entityType, entityId, title, pageSize = 20 }: AuditTailProps) {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("audit");
  const tCommon = useTranslations("common");

  const [rows, setRows] = useState<AuditLog[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next: string | null) => {
      const isInitial = next === null && rows.length === 0;
      if (isInitial) setLoading(true);
      else setLoadingMore(true);
      try {
        const params = new URLSearchParams({
          entityType,
          entityId,
          limit: String(pageSize),
        });
        if (next) params.set("cursor", next);
        const page = await apiCall<PageResponse>(`/audit?${params.toString()}`);
        setRows((prev) => (next ? [...prev, ...page.data] : page.data));
        setCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (err instanceof ApiClientError) {
          setError(err.localizedMessage(locale));
        } else {
          setError(null); // network errors fall back to the empty UI
        }
      } finally {
        if (isInitial) setLoading(false);
        setLoadingMore(false);
      }
    },
    [entityType, entityId, pageSize, locale, rows.length],
  );

  // Initial load + reload when entity changes.
  useEffect(() => {
    setRows([]);
    setCursor(null);
    void load(null);
    // We intentionally depend only on entityType/entityId here; including
    // `load` would re-fetch on every render because it closes over `rows`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, entityId]);

  const heading = title ?? t("tailTitle");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{heading}</CardTitle>
      </CardHeader>
      <CardBody>
        {error ? (
          <div className="mb-3">
            <Alert variant="error">{error}</Alert>
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
        ) : (
          <ol className="space-y-3">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-start gap-3 border-s-2 border-border ps-3"
              >
                <Badge variant={actionVariant[row.action]}>{t(`actions.${row.action}`)}</Badge>
                <div className="flex-1">
                  <p className="text-sm text-textPrimary">
                    {locale === "ar" ? row.humanReadableSummaryAr : row.humanReadableSummaryEn}
                  </p>
                  <p
                    dir="ltr"
                    className="mt-1 text-xs text-textSecondary text-start"
                  >
                    {formatDateTime(row.createdAt, locale)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}

        {cursor ? (
          <div className="mt-4 flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => void load(cursor)} disabled={loadingMore}>
              {loadingMore ? tCommon("loading") : t("loadMore")}
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
