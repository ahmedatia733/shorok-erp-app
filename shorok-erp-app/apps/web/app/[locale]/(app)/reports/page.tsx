"use client";

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../i18n";
import { Alert } from "../../../../components/ui/alert";
import { Button } from "../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui/card";

export default function ReportsStubPage() {
  const t = useTranslations("reports");
  const locale = useLocale() as AppLocale;
  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-bold">{t("title")}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <Alert variant="info">{t("placeholderTitle")}</Alert>
          <p className="text-sm text-textSecondary">{t("placeholderBody")}</p>
          <Link href={`/${locale}/dashboard`}>
            <Button>{t("goToDashboard")}</Button>
          </Link>
        </CardBody>
      </Card>
    </div>
  );
}
