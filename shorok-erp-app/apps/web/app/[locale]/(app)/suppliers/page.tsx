"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../i18n";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui/card";
import { EmptyState } from "../../../../components/ui/empty-state";
import { Skeleton } from "../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { Alert } from "../../../../components/ui/alert";
import { listSuppliers, type SupplierRow } from "../../../../lib/suppliers-client";
import { useHasRole } from "../../../../lib/auth";
import { Input } from "../../../../components/ui/input";

export default function SuppliersListPage() {
  const t = useTranslations("suppliers");
  const locale = useLocale() as AppLocale;
  const canCreate = useHasRole("ACCOUNTANT");
  const canEdit = useHasRole();

  const [rows, setRows] = useState<SupplierRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listSearch, setListSearch] = useState("");

  const displayedRows = (rows ?? []).filter((s) =>
    !listSearch ||
    (s.nameAr + " " + (s.nameEn ?? "")).toLowerCase().includes(listSearch.toLowerCase()),
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await listSuppliers();
        if (!cancelled) setRows(data);
      } catch {
        if (!cancelled) setError(t("loadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t("title")}</h1>
        {canCreate ? (
          <Link href={`/${locale}/suppliers/new`}>
            <Button>{t("create")}</Button>
          </Link>
        ) : null}
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3 flex-wrap flex-1">
            <CardTitle>{t("title")}</CardTitle>
            <Input
              placeholder="بحث باسم المورد..."
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              className="max-w-xs"
            />
            {listSearch && (
              <button type="button" className="text-xs text-textSecondary hover:text-text" onClick={() => setListSearch("")}>
                مسح ✕
              </button>
            )}
          </div>
        </CardHeader>
        <CardBody>
          {rows === null ? (
            <div className="space-y-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : displayedRows.length === 0 ? (
            <EmptyState title={listSearch ? "لا توجد نتائج مطابقة" : t("empty")} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{t("nameAr")}</TH>
                  <TH>{t("nameEn")}</TH>
                  <TH>{t("status")}</TH>
                  <TH>{t("actions")}</TH>
                </TR>
              </THead>
              <TBody>
                {displayedRows.map((s) => (
                  <TR key={s.id}>
                    <TD className="font-medium">{s.nameAr}</TD>
                    <TD className="text-textSecondary" dir="ltr">
                      {s.nameEn}
                    </TD>
                    <TD>
                      <Badge variant={s.active ? "success" : "neutral"}>
                        {s.active ? t("active") : t("archived")}
                      </Badge>
                    </TD>
                    <TD>
                      {canEdit ? (
                        <Link
                          href={`/${locale}/suppliers/${s.id}`}
                          className="text-primary hover:underline"
                        >
                          {t("edit")}
                        </Link>
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
