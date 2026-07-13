"use client";

import { Modal } from "../ui/modal";
import { Button } from "../ui/button";
import type { TreasuryWarning } from "../../lib/treasury-warning";

/**
 * Warn-only negative treasury/bank balance confirmation. Business policy allows
 * negative balances after explicit acknowledgement, so the primary action is
 * "متابعة الترحيل" (not an admin override). Cancel aborts with no posting.
 */
export function NegativeBalanceModal({
  warning,
  reference,
  submitting,
  onCancel,
  onConfirm,
}: {
  warning: TreasuryWarning | null;
  reference?: string | null;
  submitting?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const negative = warning ? parseFloat(warning.projectedBalance) < 0 : false;
  return (
    <Modal open={Boolean(warning)} onClose={() => !submitting && onCancel()} title="تحذير رصيد سالب" className="max-w-md w-full">
      {warning && (
        <div className="space-y-3 text-sm">
          <p className="text-red-600 font-medium">تحذير: هذه العملية ستجعل رصيد الخزنة/البنك سالبًا.</p>
          <div className="rounded border border-border divide-y">
            <Row label="الحساب" value={`${warning.accountName} (${warning.accountCode})`} />
            <Row label="الرصيد الحالي" value={warning.currentBalance} dir="ltr" />
            <Row label="المبلغ المسحوب" value={warning.operationCredit} dir="ltr" />
            <Row label="الرصيد بعد العملية" value={warning.projectedBalance} dir="ltr" valueClass={negative ? "text-red-600 font-bold" : ""} />
            {reference ? <Row label="المستند" value={reference} /> : null}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>إلغاء</Button>
            <Button onClick={onConfirm} disabled={submitting}>{submitting ? "جارٍ الترحيل…" : "متابعة الترحيل"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value, dir, valueClass }: { label: string; value: string; dir?: "ltr" | "rtl"; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-textSecondary">{label}</span>
      <span className={valueClass} dir={dir}>{value}</span>
    </div>
  );
}
