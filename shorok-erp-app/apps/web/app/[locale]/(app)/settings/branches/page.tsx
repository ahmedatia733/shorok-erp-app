"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Alert } from "../../../../../components/ui/alert";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { ApiClientError } from "../../../../../lib/api-client";
import {
  createBranch,
  deactivateBranch,
  listAllBranches,
  type BranchRow,
} from "../../../../../lib/admin-client";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../../../i18n";

export default function SettingsBranchesPage() {
  const t = useTranslations("settings.branches");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;

  const [rows, setRows] = useState<BranchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [location, setLocation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    void (async () => {
      try {
        const data = await listAllBranches();
        if (!cancelled) setRows(data);
      } catch {
        if (!cancelled) setError(t("loadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload, t]);

  const onCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setCreateError(null);
    setSuccess(null);
    try {
      await createBranch({
        nameAr: nameAr.trim(),
        nameEn: nameEn.trim(),
        location: location.trim() || undefined,
      });
      setNameAr("");
      setNameEn("");
      setLocation("");
      setSuccess(t("successCreated"));
      setReload((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiClientError) setCreateError(err.localizedMessage(locale));
    } finally {
      setSubmitting(false);
    }
  };

  const onDeactivate = async (id: string) => {
    try {
      await deactivateBranch(id);
      setReload((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.localizedMessage(locale));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("create")}</CardTitle>
        </CardHeader>
        <CardBody>
          {createError ? (
            <Alert variant="error" className="mb-3">
              {createError}
            </Alert>
          ) : null}
          {success ? (
            <Alert variant="success" className="mb-3">
              {success}
            </Alert>
          ) : null}
          <form onSubmit={onCreate} className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <Label htmlFor="nameAr">{t("nameAr")}</Label>
              <Input
                id="nameAr"
                required
                maxLength={120}
                value={nameAr}
                onChange={(e) => setNameAr(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div>
              <Label htmlFor="nameEn">{t("nameEn")}</Label>
              <Input
                id="nameEn"
                dir="ltr"
                required
                maxLength={120}
                value={nameEn}
                onChange={(e) => setNameEn(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div>
              <Label htmlFor="location">{t("location")}</Label>
              <Input
                id="location"
                maxLength={240}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="md:col-span-3">
              <Button type="submit" disabled={submitting || !nameAr.trim() || !nameEn.trim()}>
                {submitting ? tCommon("loading") : tCommon("save")}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardBody>
          {rows === null ? (
            <Skeleton className="h-10" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{t("nameAr")}</TH>
                  <TH>{t("nameEn")}</TH>
                  <TH>{t("location")}</TH>
                  <TH>{t("status")}</TH>
                  <TH>{t("actions")}</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((b) => (
                  <TR key={b.id}>
                    <TD className="font-medium">{b.nameAr}</TD>
                    <TD dir="ltr" className="text-textSecondary">
                      {b.nameEn}
                    </TD>
                    <TD>{b.location ?? "—"}</TD>
                    <TD>
                      <Badge variant={b.active ? "success" : "neutral"}>
                        {b.active ? t("active") : t("archived")}
                      </Badge>
                    </TD>
                    <TD>
                      {b.active ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void onDeactivate(b.id)}
                        >
                          {t("deactivate")}
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
