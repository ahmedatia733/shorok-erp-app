"use client";

import type { AppLocale } from "../../../i18n";
import { Alert } from "../../ui/alert";
import { Card, CardBody, CardHeader, CardTitle } from "../../ui/card";
import { Table, TBody, TD, TH, THead, TR } from "../../ui/table";
import { formatNumber } from "../../../lib/format";
import type { InventoryTransferPreview } from "../../../lib/inventory-transfers-client";

/**
 * The zero-write preview, rendered identically wherever a transfer is about to
 * be committed. Before and after are shown side by side for the two branches
 * AND for the company as a whole — the company columns exist so a reader can
 * check for themselves that the totals do not move.
 */
export function TransferPreviewPanel({
  preview,
  locale,
}: {
  preview: InventoryTransferPreview;
  locale: AppLocale;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>معاينة الأثر — لم يتم تسجيل أي حركة</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        {preview.blocking.length > 0 && (
          <Alert variant="error">
            <ul className="list-disc space-y-1 pe-5">
              {preview.blocking.map((b, i) => (
                <li key={i}>{b.messageAr}</li>
              ))}
            </ul>
          </Alert>
        )}

        <Table>
          <THead>
            <TR>
              <TH>الصنف</TH>
              <TH>مقاس اللوح</TH>
              <TH>ألواح</TH>
              <TH>أمتار</TH>
              <TH>المصدر قبل</TH>
              <TH>المصدر بعد</TH>
              <TH>المستلم قبل</TH>
              <TH>المستلم بعد</TH>
              <TH>الإجمالي قبل</TH>
              <TH>الإجمالي بعد</TH>
            </TR>
          </THead>
          <TBody>
            {preview.lines.map((l) => (
              <TR key={l.productVariantId}>
                <TD>
                  {l.skuCode} — {l.productNameAr}
                </TD>
                <TD>{formatNumber(l.boardSizeMeters, locale)}</TD>
                <TD>{formatNumber(l.boardQuantity, locale)}</TD>
                <TD>{formatNumber(l.meterQuantity, locale)}</TD>
                <TD>{formatNumber(l.sourceBoardsBefore, locale)}</TD>
                <TD>{formatNumber(l.sourceBoardsAfter, locale)}</TD>
                <TD>{formatNumber(l.destinationBoardsBefore, locale)}</TD>
                <TD>{formatNumber(l.destinationBoardsAfter, locale)}</TD>
                {/* Shown side by side precisely so the reader can see they match. */}
                <TD className="font-medium">{formatNumber(l.globalBoardsBefore, locale)}</TD>
                <TD className="font-medium">{formatNumber(l.globalBoardsAfter, locale)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>

        <div className="rounded-md border border-border p-3 text-sm">
          <p className="font-medium">الأثر المحاسبي: لا يوجد</p>
          <p className="text-textSecondary">{preview.accountingReasonAr}</p>
          <p className="mt-2 text-textSecondary">
            إجمالي الألواح بالشركة قبل {formatNumber(preview.totals.globalBoardsBefore, locale)} وبعد{" "}
            {formatNumber(preview.totals.globalBoardsAfter, locale)} — بدون تغيير.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
