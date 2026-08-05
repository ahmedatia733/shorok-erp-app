"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Badge } from "../../../../../../components/ui/badge";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Input } from "../../../../../../components/ui/input";
import { Label } from "../../../../../../components/ui/label";
import { Modal } from "../../../../../../components/ui/modal";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { TransferPreviewPanel } from "../../../../../../components/features/inventory/transfer-preview-panel";
import { ApiClientError } from "../../../../../../lib/api-client";
import { useHasRole } from "../../../../../../lib/auth";
import { formatCurrency, formatDate, formatDateTime, formatNumber } from "../../../../../../lib/format";
import {
  cancelTransfer,
  confirmTransfer,
  deleteTransfer,
  getTransfer,
  previewCancel,
  previewConfirm,
  transferIdempotencyKey,
  type InventoryTransferPreview,
  type InventoryTransferStatus,
  type TransferDetail,
} from "../../../../../../lib/inventory-transfers-client";

const STATUS_AR: Record<InventoryTransferStatus, string> = {
  DRAFT: "مسودة",
  CONFIRMED: "مؤكد",
  CANCELLED: "ملغي",
};

const STATUS_VARIANT: Record<InventoryTransferStatus, "neutral" | "success" | "warning"> = {
  DRAFT: "neutral",
  CONFIRMED: "success",
  CANCELLED: "warning",
};

function apiMessages(e: unknown): string[] {
  if (e instanceof ApiClientError) {
    const details = e.payload?.details as { messages?: string[]; reason?: string } | undefined;
    if (details?.messages?.length) return details.messages;
    if (details?.reason === "inventory_transfer_preview_stale") {
      return ["تغيّرت أرصدة المخزون بعد عرض المعاينة. أعد الاحتساب ثم أكّد."];
    }
    if (details?.reason === "inventory_transfer_version_stale") {
      return ["تم تعديل هذا الإذن من مكان آخر. أعد تحميل الصفحة."];
    }
  }
  return [(e as Error).message];
}

export default function InventoryTransferDetailPage() {
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const canAct = useHasRole("OWNER");

  const [transfer, setTransfer] = useState<TransferDetail | null>(null);
  const [preview, setPreview] = useState<InventoryTransferPreview | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErrors([]);
    try {
      setTransfer(await getTransfer(id));
    } catch (e) {
      setErrors(apiMessages(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const runPreview = async (op: "confirm" | "cancel") => {
    setBusy(true);
    setErrors([]);
    setPreview(null);
    try {
      setPreview(op === "confirm" ? await previewConfirm(id) : await previewCancel(id));
    } catch (e) {
      setErrors(apiMessages(e));
    } finally {
      setBusy(false);
    }
  };

  const doConfirm = async () => {
    if (!transfer || !preview) return;
    setBusy(true);
    setErrors([]);
    try {
      // Same document + same version + same preview => same key, so a retry
      // replays the first result instead of moving the stock a second time.
      const updated = await confirmTransfer(id, {
        expectedVersion: transfer.version,
        previewFingerprint: preview.previewFingerprint,
        idempotencyKey: transferIdempotencyKey("confirm", id, transfer.version, preview.previewFingerprint),
      });
      setTransfer(updated);
      setPreview(null);
    } catch (e) {
      setErrors(apiMessages(e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    if (!transfer || !preview) return;
    setBusy(true);
    setErrors([]);
    try {
      const updated = await cancelTransfer(id, {
        expectedVersion: transfer.version,
        previewFingerprint: preview.previewFingerprint,
        idempotencyKey: transferIdempotencyKey("cancel", id, transfer.version, preview.previewFingerprint),
        reason: cancelReason.trim(),
      });
      setTransfer(updated);
      setPreview(null);
      setCancelOpen(false);
      setCancelReason("");
    } catch (e) {
      setErrors(apiMessages(e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    setErrors([]);
    try {
      await deleteTransfer(id);
      router.push(`/${locale}/inventory/transfers`);
    } catch (e) {
      setErrors(apiMessages(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="text-sm text-textSecondary">جارٍ التحميل…</p>;
  if (!transfer) {
    return (
      <Alert variant="error">
        {errors[0] ?? "تعذّر تحميل إذن التحويل."}
      </Alert>
    );
  }

  const isDraft = transfer.status === "DRAFT";
  const isConfirmed = transfer.status === "CONFIRMED";
  const previewBlocked = (preview?.blocking.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">إذن تحويل مخزون {transfer.transferNumber}</h1>
          <Badge variant={STATUS_VARIANT[transfer.status]}>{STATUS_AR[transfer.status]}</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => window.print()}>
            طباعة
          </Button>
          <Link href={`/${locale}/inventory/transfers`}>
            <Button variant="ghost">رجوع</Button>
          </Link>
        </div>
      </div>

      {errors.length > 0 && (
        <Alert variant="error">
          <ul className="list-disc space-y-1 pe-5">
            {errors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>بيانات الإذن</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-3 text-sm md:grid-cols-3">
          <Field label="التاريخ" value={formatDate(transfer.transferDate, locale)} />
          <Field label="من مخزن" value={transfer.sourceBranch.nameAr} />
          <Field label="إلى مخزن" value={transfer.destinationBranch.nameAr} />
          <Field label="الغرض" value={transfer.purpose ?? "—"} />
          <Field label="ملاحظات" value={transfer.notes ?? "—"} />
          <Field label="أنشأه" value={`${transfer.createdByName ?? "—"} · ${formatDateTime(transfer.createdAt, locale)}`} />
          {transfer.confirmedAt && (
            <Field
              label="اعتمده"
              value={`${transfer.confirmedByName ?? "—"} · ${formatDateTime(transfer.confirmedAt, locale)}`}
            />
          )}
          {transfer.cancelledAt && (
            <>
              <Field
                label="ألغاه"
                value={`${transfer.cancelledByName ?? "—"} · ${formatDateTime(transfer.cancelledAt, locale)}`}
              />
              <Field label="سبب الإلغاء" value={transfer.cancellationReason ?? "—"} />
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>البنود</CardTitle>
        </CardHeader>
        <CardBody>
          <Table>
            <THead>
              <TR>
                <TH>الصنف</TH>
                <TH>مقاس اللوح (م)</TH>
                <TH>عدد الألواح</TH>
                <TH>الأمتار</TH>
                {!isDraft && <TH>تكلفة المتر</TH>}
                {!isDraft && <TH>القيمة</TH>}
              </TR>
            </THead>
            <TBody>
              {transfer.lines.map((l) => (
                <TR key={l.id}>
                  <TD>
                    {l.skuCode} — {l.productNameAr}
                  </TD>
                  <TD>{formatNumber(l.boardSizeMeters, locale)}</TD>
                  <TD>{formatNumber(l.boardQuantity, locale)}</TD>
                  <TD>{formatNumber(l.meterQuantity, locale)}</TD>
                  {!isDraft && <TD>{formatCurrency(l.costPerMeter, locale)}</TD>}
                  {!isDraft && <TD>{formatCurrency(l.totalValue, locale)}</TD>}
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="mt-3 text-sm text-textSecondary">
            الإجمالي: {formatNumber(transfer.totals.boards, locale)} لوح ·{" "}
            {formatNumber(transfer.totals.meters, locale)} متر
            {!isDraft && <> · {formatCurrency(transfer.totals.value, locale)}</>}
          </p>
          {!isDraft && (
            <p className="mt-1 text-sm text-textSecondary">
              القيمة معروضة للتوثيق فقط — التحويل لا ينشئ قيدًا محاسبيًا ولا يغيّر متوسط التكلفة.
            </p>
          )}
        </CardBody>
      </Card>

      {canAct && (isDraft || isConfirmed) && (
        <div className="flex flex-wrap gap-2 print:hidden">
          {isDraft && (
            <>
              <Button variant="secondary" onClick={() => runPreview("confirm")} disabled={busy}>
                معاينة الاعتماد
              </Button>
              <Button onClick={doConfirm} disabled={busy || !preview || previewBlocked || preview.operation !== "CONFIRM"}>
                اعتماد التحويل
              </Button>
              <Button variant="ghost" onClick={doDelete} disabled={busy}>
                حذف المسودة
              </Button>
            </>
          )}
          {isConfirmed && (
            <>
              <Button variant="secondary" onClick={() => runPreview("cancel")} disabled={busy}>
                معاينة الإلغاء
              </Button>
              <Button
                variant="danger"
                onClick={() => setCancelOpen(true)}
                disabled={busy || !preview || previewBlocked || preview.operation !== "CANCEL"}
              >
                إلغاء التحويل
              </Button>
            </>
          )}
        </div>
      )}

      {preview && (
        <div className="print:hidden">
          <TransferPreviewPanel preview={preview} locale={locale} />
        </div>
      )}

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="إلغاء إذن التحويل">
        <div className="space-y-3">
          <p className="text-sm text-textSecondary">
            سيتم إرجاع الألواح إلى المخزن المصدر بنفس التكلفة المسجّلة على الإذن. الحركات الأصلية
            تبقى كما هي، وتُسجَّل حركات عكسية جديدة.
          </p>
          <div>
            <Label htmlFor="cancel-reason">سبب الإلغاء</Label>
            <Input
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>
              تراجع
            </Button>
            <Button variant="danger" onClick={doCancel} disabled={busy || cancelReason.trim().length < 3}>
              تأكيد الإلغاء
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-textSecondary">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
