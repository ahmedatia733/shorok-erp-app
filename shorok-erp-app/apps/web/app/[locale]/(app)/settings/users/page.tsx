"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
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
  createUser,
  disableUser,
  enableUser,
  listUsers,
  type UserRow,
} from "../../../../../lib/admin-client";
import { listAllBranches, type BranchRow } from "../../../../../lib/admin-client";

const ROLES = ["OWNER", "BRANCH_MANAGER", "ACCOUNTANT", "VIEWER"] as const;

export default function SettingsUsersPage() {
  const t = useTranslations("settings.users");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;

  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [listSearch, setListSearch] = useState("");

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+20");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("BRANCH_MANAGER");
  const [allowedBranches, setAllowedBranches] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    void (async () => {
      try {
        const [users, brs] = await Promise.all([listUsers(), listAllBranches()]);
        if (!cancelled) {
          setRows(users);
          setBranches(brs);
        }
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
      await createUser({
        name: name.trim(),
        phone: phone.trim(),
        password,
        role,
        allowedBranches,
      });
      setName("");
      setPassword("");
      setAllowedBranches([]);
      setSuccess(t("successCreated"));
      setReload((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiClientError) setCreateError(err.localizedMessage(locale));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleStatus = async (u: UserRow) => {
    try {
      if (u.status === "ACTIVE") await disableUser(u.id);
      else await enableUser(u.id);
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
          <form onSubmit={onCreate} className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <Label htmlFor="name">{t("name")}</Label>
              <Input
                id="name"
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div>
              <Label htmlFor="phone">{t("phone")}</Label>
              <Input
                id="phone"
                type="tel"
                dir="ltr"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div>
              <Label htmlFor="password">{t("password")}</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div>
              <Label htmlFor="role">{t("role")}</Label>
              <select
                id="role"
                value={role}
                onChange={(e) => setRole(e.target.value as typeof ROLES[number])}
                disabled={submitting}
                className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`roles.${r}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <Label>{t("allowedBranches")}</Label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {branches.map((b) => (
                  <label key={b.id} className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={allowedBranches.includes(b.id)}
                      onChange={(e) =>
                        setAllowedBranches((prev) =>
                          e.target.checked
                            ? [...prev, b.id]
                            : prev.filter((x) => x !== b.id),
                        )
                      }
                      disabled={submitting}
                      className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <span>{locale === "ar" ? b.nameAr : b.nameEn}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="md:col-span-2">
              <Button
                type="submit"
                disabled={
                  submitting || !name.trim() || !phone.trim() || password.length < 8
                }
              >
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
          <div className="flex items-center gap-2">
            <Input placeholder="بحث..." value={listSearch} onChange={(e) => setListSearch(e.target.value)} className="max-w-xs" />
            {listSearch && <button type="button" className="text-xs text-textSecondary hover:text-text" onClick={() => setListSearch("")}>مسح ✕</button>}
          </div>
        </CardHeader>
        <CardBody>
          {rows === null ? (
            <Skeleton className="h-10" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{t("name")}</TH>
                  <TH>{t("phone")}</TH>
                  <TH>{t("role")}</TH>
                  <TH>{t("status")}</TH>
                  <TH>{t("actions")}</TH>
                </TR>
              </THead>
              <TBody>
                {(listSearch ? (rows ?? []).filter((u) => (u.name + " " + (u.phone ?? "")).toLowerCase().includes(listSearch.toLowerCase())) : (rows ?? [])).map((u) => (
                  <TR key={u.id}>
                    <TD className="font-medium">{u.name}</TD>
                    <TD dir="ltr" className="text-textSecondary">
                      {u.phone}
                    </TD>
                    <TD>{t(`roles.${u.role}`)}</TD>
                    <TD>
                      <Badge variant={u.status === "ACTIVE" ? "success" : "neutral"}>
                        {u.status === "ACTIVE" ? t("active") : t("disabled")}
                      </Badge>
                    </TD>
                    <TD>
                      <Button variant="ghost" size="sm" onClick={() => void toggleStatus(u)}>
                        {u.status === "ACTIVE" ? t("disable") : t("enable")}
                      </Button>
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
