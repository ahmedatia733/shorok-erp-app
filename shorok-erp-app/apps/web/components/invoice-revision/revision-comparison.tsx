"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Alert } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "../ui/table";
import { formatCurrency, formatDate } from "../../lib/format";
import type { InvoiceRevisionPreview } from "../../lib/invoice-revisions-client";

/**
 * The comparison screen an owner has to read before a confirmed invoice can be
 * reposted. It shows what changes, what it does to stock, what it posts to the
 * ledger, what it leaves the customer or supplier owing, and what the linked
 * returns forbid — before anything is written.
 */

const HEADER_LABELS: Record<string, string> = {
  invoiceDate: "تاريخ الفاتورة",
  dueDate: "تاريخ الاستحقاق",
  customerNameAr: "العميل",
  supplierNameAr: "المورد",
  branchNameAr: "الفرع / المخزن",
  salesRepresentativeId: "المندوب",
  notes: "ملاحظات",
  taxRate: "نسبة الضريبة %",
  basedOn: "بناءً على",
  docDirection: "اتجاه المستند",
  customsNumber: "رقم الجمارك",
};

/** Only the badge colour lives here; the words come from the message files. */
const CHANGE_VARIANTS: Record<string, "success" | "danger" | "warning" | "neutral"> = {
  ADDED: "success",
  REMOVED: "danger",
  CHANGED: "warning",
  UNCHANGED: "neutral",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border">
      <h3 className="border-b border-border bg-background px-4 py-2 text-sm font-semibold text-textPrimary">{title}</h3>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Delta({ value, invert = false }: { value: string; invert?: boolean }) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return <span className="text-textSecondary">—</span>;
  const good = invert ? n < 0 : n > 0;
  return (
    <span className={good ? "text-success-foreground" : "text-danger-foreground"}>
      {n > 0 ? "+" : ""}
      {value}
    </span>
  );
}

export function RevisionComparison({
  preview,
  acknowledged,
  onToggleAcknowledged,
}: {
  preview: InvoiceRevisionPreview;
  acknowledged: string[];
  onToggleAcknowledged: (code: string) => void;
}) {
  const t = useTranslations("invoiceRevision");
  const [openJournal, setOpenJournal] = useState<string | null>(null);
  const changedHeader = preview.header.filter((f) => (f.before ?? "") !== (f.after ?? ""));
  const money = (v: string | null | undefined) => (v == null ? "—" : formatCurrency(v, "ar"));

  return (
    <div className="space-y-4" dir="rtl">
      {preview.blocking.length > 0 && (
        <Alert variant="error">
          <strong className="block mb-1">{t("blockedTitle")}</strong>
          <ul className="list-disc space-y-1 ps-5 text-sm">
            {preview.blocking.map((b) => (
              <li key={b.code + (b.context?.lineId ?? "")}>{b.messageAr}</li>
            ))}
          </ul>
        </Alert>
      )}

      {preview.warnings.length > 0 && (
        <Alert variant="warning">
          <strong className="block mb-1">{t("warningsTitle")}</strong>
          <ul className="space-y-2 text-sm">
            {preview.warnings.map((w) => (
              <li key={w.code} className="flex items-start gap-2">
                <input
                  id={`ack-${w.code}`}
                  type="checkbox"
                  className="mt-1"
                  checked={acknowledged.includes(w.code)}
                  onChange={() => onToggleAcknowledged(w.code)}
                />
                <label htmlFor={`ack-${w.code}`} className="cursor-pointer">{w.messageAr}</label>
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Alert variant="info">
        سيتم عكس الأثر المحاسبي والمخزني للنسخة الحالية بالكامل ثم إعادة ترحيل النسخة المعدلة. رقم الفاتورة
        <strong className="mx-1">{preview.invoiceNumber}</strong>
        وحالتها <strong>{preview.resultingStatus === "CONFIRMED" ? "مؤكدة" : preview.resultingStatus}</strong> لن يتغيرا،
        وستصبح النسخة رقم <strong>{preview.proposedRevision}</strong>. لن يتم حذف أي قيد أو حركة سابقة.
      </Alert>

      {/* 1 ── بيانات الفاتورة */}
      <Section title={t("sections.header")}>
        {changedHeader.length === 0 ? (
          <p className="text-sm text-textSecondary">لا يوجد تغيير في بيانات الرأس.</p>
        ) : (
          <Table>
            <THead>
              <TR><TH>البيان</TH><TH>قبل</TH><TH>بعد</TH></TR>
            </THead>
            <TBody>
              {changedHeader.map((f) => (
                <TR key={f.field}>
                  <TD>{HEADER_LABELS[f.field] ?? f.field}</TD>
                  <TD className="text-textSecondary">{f.before ?? "—"}</TD>
                  <TD className="font-medium">{f.after ?? "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          <div>تاريخ المستند: <strong>{formatDate(preview.documentDate, "ar")}</strong></div>
          <div>تاريخ الترحيل المحاسبي: <strong>{formatDate(preview.postingDate, "ar")}</strong></div>
          <div>
            الفترة المحاسبية:{" "}
            {preview.crossesClosedPeriod
              ? <Badge variant="warning">فترة مقفلة — ترحيل في أول فترة مفتوحة</Badge>
              : <Badge variant="success">مفتوحة</Badge>}
          </div>
        </div>
        {preview.periodNoteAr && <p className="mt-2 text-sm text-warning-foreground">{preview.periodNoteAr}</p>}
      </Section>

      {/* 2 ── الأصناف */}
      <Section title={t("sections.lines")}>
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>التغيير</TH><TH>الكود</TH><TH>اللون</TH><TH>المقاس</TH>
                <TH>الألواح قبل / بعد</TH><TH>الأمتار قبل / بعد</TH><TH>السعر قبل / بعد</TH>
                <TH>الإجمالي قبل / بعد</TH><TH>مرتجع مرتبط</TH>
              </TR>
            </THead>
            <TBody>
              {preview.lineDiffs.map((d, i) => {
                const variant = CHANGE_VARIANTS[d.change] ?? "neutral";
                return (
                  <TR key={`${d.lineId ?? "new"}-${i}`}>
                    <TD><Badge variant={variant}>{t(`change.${d.change}`)}</Badge></TD>
                    <TD>{d.productCode ?? "—"}</TD>
                    <TD>{d.colorName ?? "—"}</TD>
                    <TD>{d.sizeLabel ?? "—"}</TD>
                    <TD>{d.before?.boards ?? "—"} / <strong>{d.after?.boards ?? "—"}</strong></TD>
                    <TD>{d.before?.meters ?? "—"} / <strong>{d.after?.meters ?? "—"}</strong></TD>
                    <TD>{d.before?.unitPrice ?? "—"} / <strong>{d.after?.unitPrice ?? "—"}</strong></TD>
                    <TD>{money(d.before?.lineTotal)} / <strong>{money(d.after?.lineTotal)}</strong></TD>
                    <TD>{Number(d.linkedReturnedBoards) > 0 ? <Badge variant="info">{d.linkedReturnedBoards}</Badge> : "—"}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
        <div className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
          {Object.keys(preview.revisedTotals).map((k) => (
            <div key={k} className="rounded border border-border p-2">
              <div className="text-xs text-textSecondary">{k}</div>
              <div>{preview.currentTotals[k] ?? "—"} ← <strong>{preview.revisedTotals[k]}</strong></div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-sm">
          فرق الإجمالي: <strong><Delta value={preview.totalDelta} /></strong> ج.م
        </p>
      </Section>

      {/* 3 ── التأثير على المخزون */}
      <Section title={t("sections.stock")}>
        {preview.branchQuantityDelta.length === 0 ? (
          <p className="text-sm text-textSecondary">لا يوجد أي تغيير في الكميات.</p>
        ) : (
          <Table>
            <THead>
              <TR><TH>الفرع / المخزن</TH><TH>الصنف</TH><TH>صافي فرق الألواح</TH><TH>صافي فرق الأمتار</TH></TR>
            </THead>
            <TBody>
              {preview.branchQuantityDelta.map((s, i) => (
                <TR key={`${s.branchId}-${s.productVariantId}-${i}`}>
                  <TD>{s.branchNameAr}</TD>
                  <TD>{s.productCode ?? s.productVariantId.slice(0, 8)}</TD>
                  <TD><Delta value={s.boardsDelta} /></TD>
                  <TD><Delta value={s.metersDelta} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <h4 className="mb-1 text-xs font-semibold text-textSecondary">المرتجع للفرع الأصلي (عكس النسخة الحالية)</h4>
            <ul className="space-y-1 text-sm">
              {preview.stockReversal.length === 0 && <li className="text-textSecondary">—</li>}
              {preview.stockReversal.map((s, i) => (
                <li key={i}>{s.branchNameAr}: {s.productCode ?? "—"} — {s.boardsDelta} لوح / {s.metersDelta} م</li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold text-textSecondary">الحركة بعد التعديل</h4>
            <ul className="space-y-1 text-sm">
              {preview.stockApplication.length === 0 && <li className="text-textSecondary">—</li>}
              {preview.stockApplication.map((s, i) => (
                <li key={i}>{s.branchNameAr}: {s.productCode ?? "—"} — {s.boardsDelta} لوح / {s.metersDelta} م</li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-4 rounded border border-border bg-background p-3">
          <h4 className="mb-2 text-xs font-semibold">متوسط التكلفة المشترك</h4>
          <p className="mb-2 text-sm text-textSecondary">{preview.valuation.reasonAr}</p>
          {preview.valuation.variants.length > 0 && (
            <Table>
              <THead>
                <TR>
                  <TH>الصنف</TH><TH>متوسط التكلفة قبل</TH><TH>بعد</TH>
                  <TH>فرق قيمة المخزون</TH><TH>فرق تكلفة المبيعات</TH><TH>إعادة الاحتساب</TH>
                </TR>
              </THead>
              <TBody>
                {preview.valuation.variants.map((v) => (
                  <TR key={v.productVariantId}>
                    <TD>{v.productCode ?? v.productVariantId.slice(0, 8)}{v.sizeLabel ? ` / ${v.sizeLabel}` : ""}</TD>
                    <TD>{v.currentWacPerMeter}</TD>
                    <TD className="font-medium">{v.projectedWacPerMeter}</TD>
                    <TD><Delta value={v.inventoryValueDelta} /></TD>
                    <TD><Delta value={v.cogsDelta} invert /></TD>
                    <TD>
                      {v.replayEventCount > 0
                        ? (v.replayReproducedCurrentState
                            ? <Badge variant="success">مطابقة ({v.replayEventCount} حركة)</Badge>
                            : <Badge variant="danger">غير مطابقة</Badge>)
                        : <Badge variant="neutral">غير مطلوبة</Badge>}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>
      </Section>

      {/* 4 ── التأثير المحاسبي */}
      <Section title={t("sections.accounting")}>
        <ul className="space-y-2">
          {preview.journals.map((j) => (
            <li key={j.kind} className="rounded border border-border">
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-start text-sm"
                onClick={() => setOpenJournal(openJournal === j.kind ? null : j.kind)}
              >
                <span>
                  <strong>{t(`journal.${j.kind}`)}</strong>
                  <span className="ms-2 text-textSecondary">{j.descriptionAr}</span>
                </span>
                <span className="text-textSecondary">
                  مدين {formatCurrency(j.totalDebit, "ar")} / دائن {formatCurrency(j.totalCredit, "ar")}
                </span>
              </button>
              {openJournal === j.kind && (
                <div className="border-t border-border p-2">
                  <Table>
                    <THead>
                      <TR><TH>الحساب</TH><TH>مدين</TH><TH>دائن</TH><TH>البيان</TH></TR>
                    </THead>
                    <TBody>
                      {j.lines.map((l, i) => (
                        <TR key={i}>
                          <TD>{l.accountCode} — {l.accountNameAr}</TD>
                          <TD>{formatCurrency(l.debit, "ar")}</TD>
                          <TD>{formatCurrency(l.credit, "ar")}</TD>
                          <TD className="text-textSecondary">{l.note ?? "—"}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                  <p className="mt-2 text-xs text-textSecondary">تاريخ الترحيل: {formatDate(j.postingDate, "ar")}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>

      {/* 5 ── الحساب */}
      <Section title={t("sections.account")}>
        <Table>
          <THead>
            <TR><TH>البيان</TH><TH>قبل التعديل</TH><TH>بعد التعديل</TH></TR>
          </THead>
          <TBody>
            <TR>
              <TD>{preview.invoiceKind === "SALES" ? "العميل" : "المورد"}</TD>
              <TD>{preview.partyImpactBefore?.partyNameAr ?? "—"}</TD>
              <TD className="font-medium">{preview.partyImpactAfter?.partyNameAr ?? "—"}</TD>
            </TR>
            <TR>
              <TD>قيمة الفاتورة على الحساب</TD>
              <TD>{money(preview.partyImpactBefore?.balanceDelta)}</TD>
              <TD className="font-medium">{money(preview.partyImpactAfter?.balanceDelta)}</TD>
            </TR>
            <TR>
              <TD>{preview.invoiceKind === "SALES" ? "المحصّل المخصص" : "المدفوع المخصص"}</TD>
              <TD>{money(preview.partyImpactBefore?.allocatedAmount)}</TD>
              <TD>{money(preview.partyImpactAfter?.allocatedAmount)}</TD>
            </TR>
            <TR>
              <TD>المتبقي</TD>
              <TD>{money(preview.partyImpactBefore?.outstandingAfter)}</TD>
              <TD className="font-medium">{money(preview.partyImpactAfter?.outstandingAfter)}</TD>
            </TR>
            <TR>
              <TD>{preview.invoiceKind === "SALES" ? "رصيد دائن للعميل" : "دفعة مقدمة لدى المورد"}</TD>
              <TD>{money(preview.partyImpactBefore?.creditAfter)}</TD>
              <TD className="font-medium">{money(preview.partyImpactAfter?.creditAfter)}</TD>
            </TR>
          </TBody>
        </Table>
        <h4 className="mb-1 mt-3 text-xs font-semibold text-textSecondary">
          السندات المرتبطة — لن يتم تعديلها أو حذفها
        </h4>
        {preview.linkedVouchers.length === 0 ? (
          <p className="text-sm text-textSecondary">لا توجد سندات مرتبطة.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {preview.linkedVouchers.map((v) => (
              <li key={v.voucherId}>
                سند رقم {v.voucherNumber} — {formatDate(v.date, "ar")} — قيمة {formatCurrency(v.amount, "ar")} — مخصص لهذه الفاتورة {formatCurrency(v.allocated, "ar")}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 6 ── المرتجعات */}
      <Section title={t("sections.returns")}>
        {preview.linkedReturns.length === 0 ? (
          <p className="text-sm text-textSecondary">لا توجد مرتجعات مرتبطة بهذه الفاتورة.</p>
        ) : (
          <>
            <Table>
              <THead>
                <TR><TH>رقم المردود</TH><TH>التاريخ</TH><TH>الحالة</TH><TH>عدد الألواح</TH></TR>
              </THead>
              <TBody>
                {preview.linkedReturns.map((r) => (
                  <TR key={r.returnId}>
                    <TD>{r.returnNumber}</TD>
                    <TD>{formatDate(r.date, "ar")}</TD>
                    <TD>{r.status === "CONFIRMED" ? <Badge variant="success">مؤكد</Badge> : <Badge>{r.status}</Badge>}</TD>
                    <TD>{r.boards}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <p className="mt-2 text-sm text-textSecondary">
              المرتجعات المؤكدة لا تتغير بالتعديل، ولا يمكن أن تقل كمية أي بند عن الكمية المرتجعة منه.
            </p>
          </>
        )}
      </Section>
    </div>
  );
}
