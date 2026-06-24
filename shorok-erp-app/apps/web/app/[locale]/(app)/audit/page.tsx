"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AuditAction, AuditLog } from "@shorok/shared";
import type { AppLocale } from "../../../../i18n";
import { Alert } from "../../../../components/ui/alert";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Card, CardBody } from "../../../../components/ui/card";
import { EmptyState } from "../../../../components/ui/empty-state";
import { Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";
import { Skeleton } from "../../../../components/ui/skeleton";
import { ApiClientError } from "../../../../lib/api-client";
import { listAudit, revertAuditAction, type AuditFilters } from "../../../../lib/audit-client";
import { useCurrentUser } from "../../../../lib/auth";
import { formatDateTime } from "../../../../lib/format";

const actionVariant: Record<
  AuditAction,
  "neutral" | "success" | "warning" | "danger" | "info"
> = {
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

export default function AuditViewerPage() {
  const t = useTranslations("auditViewer");
  const tAudit = useTranslations("audit");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;

  const [filters, setFilters] = useState<AuditFilters>({});
  const [draft, setDraft] = useState<AuditFilters>({});
  const [rows, setRows] = useState<AuditLog[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next: string | null, append: boolean) => {
      try {
        if (!append) setLoading(true);
        else setLoadingMore(true);
        setError(null);
        const page = await listAudit({ ...filters, cursor: next, limit: 20 });
        setRows((prev) => (append ? [...prev, ...page.data] : page.data));
        setCursor(page.nextCursor);
      } catch {
        setError(t("loadFailed"));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [filters, t],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFilters(draft);
  };

  const reset = () => {
    setDraft({});
    setFilters({});
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t("title")}</h1>

      <Card>
        <CardBody>
          <form
            onSubmit={onSubmit}
            className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5"
            noValidate
          >
            <div>
              <Label htmlFor="entityType">{t("entityType")}</Label>
              <Input
                id="entityType"
                type="text"
                value={draft.entityType ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, entityType: e.target.value || undefined })
                }
                placeholder="expense, customer_order, …"
                dir="ltr"
              />
            </div>
            <div>
              <Label htmlFor="entityId">{t("entityId")}</Label>
              <Input
                id="entityId"
                type="text"
                value={draft.entityId ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, entityId: e.target.value || undefined })
                }
                dir="ltr"
              />
            </div>
            <div>
              <Label htmlFor="actorId">{t("actor")}</Label>
              <Input
                id="actorId"
                type="text"
                value={draft.actorId ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, actorId: e.target.value || undefined })
                }
                placeholder={t("actorIdHint")}
                dir="ltr"
              />
            </div>
            <div>
              <Label htmlFor="from">{t("from")}</Label>
              <Input
                id="from"
                type="date"
                dir="ltr"
                value={draft.from ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, from: e.target.value || undefined })
                }
              />
            </div>
            <div>
              <Label htmlFor="to">{t("to")}</Label>
              <Input
                id="to"
                type="date"
                dir="ltr"
                value={draft.to ?? ""}
                onChange={(e) => setDraft({ ...draft, to: e.target.value || undefined })}
              />
            </div>
            <div className="md:col-span-2 lg:col-span-5 flex gap-2">
              <Button type="submit">{t("apply")}</Button>
              <Button type="button" variant="ghost" onClick={reset}>
                {t("reset")}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title={tAudit("emptyTitle")} description={tAudit("emptyDescription")} />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <AuditRow key={row.id} row={row} locale={locale} />
          ))}
          {cursor ? (
            <div className="flex justify-center pt-2">
              <Button
                variant="secondary"
                onClick={() => void load(cursor, true)}
                disabled={loadingMore}
              >
                {loadingMore ? tCommon("loading") : tCommon("loadMore")}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

const REVERTIBLE = new Set([
  "DELETE:expense",
  "UPDATE:expense",
  "DELETE:factory_ledger_entry",
  "UPDATE:factory_ledger_entry",
  "UPDATE:branch",
  "UPDATE:supplier",
  "UPDATE:product_sku",
  "UPDATE:product_variant",
]);

function AuditRow({ row, locale }: { row: AuditLog; locale: AppLocale }) {
  const tAudit = useTranslations("audit");
  const t = useTranslations("auditViewer");
  const user = useCurrentUser();
  const [expanded, setExpanded] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertMsg, setRevertMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const summary = locale === "ar" ? row.humanReadableSummaryAr : row.humanReadableSummaryEn;
  const hasDetails =
    (row.beforeSnapshot && Object.keys(row.beforeSnapshot as object).length > 0) ||
    (row.afterSnapshot && Object.keys(row.afterSnapshot as object).length > 0);

  const canRevert = user?.role === "OWNER" && (row.action === "DELETE" || row.action === "UPDATE");

  const handleRevert = async () => {
    setReverting(true);
    setRevertMsg(null);
    try {
      await revertAuditAction(row.id);
      setRevertMsg({ ok: true, text: t("revertSuccess") });
    } catch (err: unknown) {
      const msg =
        err instanceof ApiClientError
          ? err.localizedMessage(locale)
          : t("revertFailed");
      setRevertMsg({ ok: false, text: msg });
    } finally {
      setReverting(false);
    }
  };

  return (
    <Card>
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant={actionVariant[row.action]}>{tAudit(`actions.${row.action}`)}</Badge>
              <span className="text-xs text-textSecondary" dir="ltr">
                {row.entityType}
              </span>
            </div>
            <p className="text-sm">{summary}</p>
            <div className="mt-1 text-xs text-textSecondary" dir="ltr">
              {formatDateTime(row.createdAt, locale)}
            </div>
          </div>
          {canRevert ? (
            <div className="flex-shrink-0">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleRevert()}
                disabled={reverting || revertMsg?.ok === true}
              >
                {reverting ? t("reverting") : t("revert")}
              </Button>
            </div>
          ) : null}
        </div>

        {revertMsg ? (
          <Alert variant={revertMsg.ok ? "success" : "error"} className="mt-2 text-sm">
            {revertMsg.text}
          </Alert>
        ) : null}

        {hasDetails ? (
          <div className="mt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? t("hideDetails") : t("showDetails")}
            </Button>
            {expanded ? (
              <pre
                dir="ltr"
                className="mt-2 max-h-80 overflow-auto rounded-md bg-background p-3 text-xs"
              >
                {JSON.stringify(
                  { before: row.beforeSnapshot, after: row.afterSnapshot },
                  null,
                  2,
                )}
              </pre>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
