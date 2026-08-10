"use client";

import type { AppLocale } from "../../../i18n";
import { Alert } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Modal } from "../../ui/modal";
import { Skeleton } from "../../ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../ui/table";
import { formatDate } from "../../../lib/format";
import type { ProfitabilityDetail, ProfitabilityLine } from "../../../lib/invoice-profitability-client";
import { CoverageBadge, Money, Pct } from "./profitability-tables";

const SIZE_AR: Record<ProfitabilityLine["sizeMode"], string> = {
  LARGE: "كبير",
  SMALL: "صغير",
  CUSTOM: "مخصص",
  DEFAULT: "افتراضي",
};

const BASIS_AR: Record<ProfitabilityLine["costBasis"], string> = {
  METER_SNAPSHOT: "تكلفة المتر وقت البيع",
  LEGACY_BOARD: "تكلفة اللوح وقت البيع",
  MISSING: "لم تُسجَّل",
};

/**
 * One invoice's profitability, line by line.
 *
 * The line values are the invoice's own persisted figures — quantities, price,
 * discount and the cost snapshot taken at posting. Only the product's code,
 * name and size are resolved live from the catalogue, matching what the invoice
 * screen shows; renaming a product changes the label, never the money.
 */
export function InvoiceProfitDetail({
  open,
  onClose,
  detail,
  loading,
  error,
  locale,
  onPdf,
  pdfBusy,
}: {
  open: boolean;
  onClose: () => void;
  detail: ProfitabilityDetail | null;
  loading: boolean;
  error: string | null;
  locale: AppLocale;
  onPdf: () => void;
  pdfBusy: boolean;
}) {
  const inv = detail?.invoice;

  return (
    <Modal open={open} onClose={onClose} title={inv ? `ربحية الفاتورة رقم ${inv.invoiceNumber}` : "ربحية الفاتورة"}>
      <div className="space-y-4" dir="rtl" data-testid="ip-detail">
        {loading && <Skeleton className="h-48 w-full" />}
        {error && <Alert variant="error">{error}</Alert>}

        {!loading && !error && detail && inv && (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              {[
                { k: "التاريخ", v: formatDate(inv.invoiceDate, locale) },
                { k: "العميل", v: inv.customerCode ? `${inv.customerCode} — ${inv.customerName ?? ""}` : inv.customerName ?? "—" },
                { k: "الفرع", v: inv.branchName ?? "—" },
                { k: "مندوب المبيعات", v: inv.salesRepresentativeName ?? "—" },
                { k: "حالة الفاتورة", v: inv.status === "CONFIRMED" ? "مؤكدة" : inv.status },
                ...(inv.revisionNumber > 1 ? [{ k: "رقم المراجعة", v: String(inv.revisionNumber) }] : []),
              ].map((f) => (
                <div key={f.k} className="rounded border border-border p-2">
                  <div className="text-xs text-textSecondary">{f.k}</div>
                  <div className="text-sm font-medium">{f.v}</div>
                </div>
              ))}
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              {[
                { k: "صافي المبيعات بدون الضريبة", v: <Money value={inv.netSalesExVat} locale={locale} bold /> },
                { k: "التكلفة التاريخية", v: <Money value={inv.cogs} locale={locale} /> },
                { k: "إجمالي الربح", v: <Money value={inv.grossProfit} locale={locale} bold /> },
                { k: "هامش الربح", v: <Pct value={inv.marginPct} /> },
                { k: "المرتجعات المرتبطة", v: <Money value={inv.returnNetExVat} locale={locale} /> },
                { k: "صافي الربح بعد المرتجعات", v: <Money value={inv.finalProfit} locale={locale} bold /> },
              ].map((c) => (
                <div key={c.k} className="rounded border border-border bg-background p-2">
                  <div className="text-xs text-textSecondary">{c.k}</div>
                  <div className="mt-1 text-base">{c.v}</div>
                </div>
              ))}
            </div>

            {inv.costCoverage !== "COMPLETE" && (
              <Alert variant="warning" data-testid="ip-detail-incomplete">
                التكلفة التاريخية غير مكتملة: {inv.linesMissingCost} من {inv.lineCount} بند بلا تكلفة مسجّلة وقت البيع،
                لذلك لا يمكن عرض ربح موثوق لهذه الفاتورة. أرقام المبيعات صحيحة ومكتملة.
              </Alert>
            )}

            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>الكود</TH>
                    <TH>الصنف</TH>
                    <TH>المقاس</TH>
                    <TH>الألواح</TH>
                    <TH>الأمتار</TH>
                    <TH>سعر المتر</TH>
                    <TH>الخصم</TH>
                    <TH>صافي البيع</TH>
                    <TH>تكلفة المتر وقت البيع</TH>
                    <TH>التكلفة</TH>
                    <TH>الربح</TH>
                    <TH>الهامش</TH>
                    <TH>مرتجع</TH>
                    <TH>قيمة المرتجع</TH>
                    <TH>صافي ربح البند</TH>
                    <TH>أساس التكلفة</TH>
                  </TR>
                </THead>
                <TBody>
                  {detail.lines.map((l) => (
                    <TR key={l.id} data-testid={`ip-line-${l.productCode}`}>
                      <TD className="font-mono">{l.productCode}</TD>
                      <TD>{l.productName}</TD>
                      <TD>
                        <Badge variant="neutral">{SIZE_AR[l.sizeMode]}</Badge>{" "}
                        <span dir="ltr">{Number(l.variantSize)} م</span>
                        {l.lengthM && (
                          <span className="text-textSecondary" dir="ltr">
                            {" "}({Number(l.lengthM)}{l.widthM ? ` × ${Number(l.widthM)}` : ""} م)
                          </span>
                        )}
                      </TD>
                      <TD dir="ltr">{Number(l.boards)}</TD>
                      <TD dir="ltr">{Number(l.meters)}</TD>
                      <TD dir="ltr"><Money value={l.salePricePerMeter} locale={locale} /></TD>
                      <TD dir="ltr"><Money value={l.discount} locale={locale} /></TD>
                      <TD dir="ltr"><Money value={l.netSalesExVat} locale={locale} /></TD>
                      <TD dir="ltr">
                        {l.costPerMeterAtPosting === null
                          ? <span className="text-warning italic">غير متاحة</span>
                          : <span className="tabular-nums">{Number(l.costPerMeterAtPosting).toFixed(4)}</span>}
                      </TD>
                      <TD dir="ltr"><Money value={l.cogs} locale={locale} /></TD>
                      <TD dir="ltr"><Money value={l.grossProfit} locale={locale} bold /></TD>
                      <TD dir="ltr"><Pct value={l.marginPct} /></TD>
                      <TD dir="ltr">{Number(l.returnedBoards) || "—"}</TD>
                      <TD dir="ltr"><Money value={l.returnNetExVat} locale={locale} /></TD>
                      <TD dir="ltr"><Money value={l.finalProfit} locale={locale} bold /></TD>
                      <TD>
                        {l.costBasis === "MISSING"
                          ? <Badge variant="warning">{BASIS_AR.MISSING}</Badge>
                          : <span className="text-xs text-textSecondary">{BASIS_AR[l.costBasis]}</span>}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>

            {detail.returns.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-semibold">مردودات المبيعات المرتبطة</h3>
                <Table>
                  <THead>
                    <TR>
                      <TH>رقم المرتجع</TH>
                      <TH>التاريخ</TH>
                      <TH>الألواح</TH>
                      <TH>القيمة بدون ضريبة</TH>
                      <TH>التكلفة المعكوسة</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {detail.returns.map((r) => (
                      <TR key={r.id}>
                        <TD className="font-mono">{r.returnNumber}</TD>
                        <TD>{formatDate(r.returnDate, locale)}</TD>
                        <TD dir="ltr">{Number(r.boards)}</TD>
                        <TD dir="ltr"><Money value={r.netExVat} locale={locale} /></TD>
                        <TD dir="ltr"><Money value={r.cogs} locale={locale} /></TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-textSecondary">
                <CoverageBadge coverage={inv.costCoverage} missing={inv.linesMissingCost} /> اكتمال التكلفة التاريخية
              </span>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onPdf} disabled={pdfBusy} data-testid="ip-detail-pdf">
                  {pdfBusy ? "جارٍ إنشاء الملف…" : "حفظ PDF"}
                </Button>
                <Button variant="ghost" onClick={onClose}>إغلاق</Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
