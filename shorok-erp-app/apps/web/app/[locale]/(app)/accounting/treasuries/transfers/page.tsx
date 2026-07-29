"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Badge } from "../../../../../../components/ui/badge";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Input } from "../../../../../../components/ui/input";
import { Label } from "../../../../../../components/ui/label";
import { Modal } from "../../../../../../components/ui/modal";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { useHasRole } from "../../../../../../lib/auth";
import { ApiClientError } from "../../../../../../lib/api-client";
import {
  listTransfers, createTransfer, confirmTransfer, cancelTransfer, treasurySelector,
  type TransferRow, type TreasuryRow,
} from "../../../../../../lib/treasuries-client";
import { money, treasuryOptionLabel, validateTransferForm } from "../../../../../../lib/treasury-format";

function statusVariant(status: string): "neutral" | "success" | "warning" {
  if (status === "CONFIRMED") return "success";
  if (status === "CANCELLED") return "neutral";
  return "warning";
}

export default function TreasuryTransfersPage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("treasury");
  const canManage = useHasRole("OWNER", "ACCOUNTANT");
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [treasuries, setTreasuries] = useState<TreasuryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const statusLabel = (s: string) => (s === "CONFIRMED" ? t("statusConfirmed") : s === "CANCELLED" ? t("statusCancelled") : t("statusDraft"));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tr, sel] = await Promise.all([listTransfers(), treasurySelector()]);
      setRows(tr.items); setTreasuries(sel.items); setError(null);
    } catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("errTransfers")); }
    finally { setLoading(false); }
  }, [locale, t]);

  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("errAction")); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("transfersTitle")}</h1>
          <p className="text-sm text-textSecondary">{t("transfersSubtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/${locale}/accounting/treasuries`}><Button variant="ghost">{t("treasuriesLink")}</Button></Link>
          {canManage && <Button onClick={() => setOpen(true)} data-testid="add-transfer">{t("newTransfer")}</Button>}
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <Card>
        <CardHeader><CardTitle>{t("transfersListTitle")}</CardTitle></CardHeader>
        <CardBody>
          {loading ? <Skeleton className="h-40 w-full" /> : rows.length === 0 ? (
            <p className="py-8 text-center text-textSecondary">{t("noTransfers")}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR><TH>{t("colNumber")}</TH><TH>{t("colDate")}</TH><TH>{t("colFrom")}</TH><TH>{t("colTo")}</TH><TH>{t("colAmount")}</TH><TH>{t("colStatus")}</TH><TH>{t("entryLink")}</TH><TH>{t("colActions")}</TH></TR>
                </THead>
                <TBody>
                  {rows.map((r) => (
                    <TR key={r.id} data-testid="transfer-row">
                      <TD className="font-mono text-xs">TRF-{r.transferNumber}</TD>
                      <TD>{r.transferDate}</TD>
                      <TD>{r.sourceTreasuryNameAr}</TD>
                      <TD>{r.destinationTreasuryNameAr}</TD>
                      <TD className="tabular-nums">{money(r.amount, locale)}</TD>
                      <TD><Badge variant={statusVariant(r.status)}>{statusLabel(r.status)}</Badge></TD>
                      <TD>{r.journalEntryId ? <Link href={`/${locale}/accounting/journal`} className="text-primary hover:underline text-xs">{t("showLink")}</Link> : "—"}</TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          {canManage && r.status === "DRAFT" && <button onClick={() => void act(() => confirmTransfer(r.id))} className="text-sm text-primary hover:underline" data-testid="confirm-transfer">{t("confirm")}</button>}
                          {canManage && r.status !== "CANCELLED" && <button onClick={() => { const reason = window.prompt(t("cancelReasonPrompt")); if (reason) void act(() => cancelTransfer(r.id, reason)); }} className="text-sm text-textSecondary hover:underline">{t("statusCancelled")}</button>}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>

      {open && <CreateTransferModal treasuries={treasuries} onClose={() => setOpen(false)} onCreated={async () => { setOpen(false); await load(); }} />}
    </div>
  );
}

function CreateTransferModal({ treasuries, onClose, onCreated }: { treasuries: TreasuryRow[]; onClose: () => void; onCreated: () => void }) {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("treasury");
  const [transferDate, setTransferDate] = useState(new Date().toISOString().slice(0, 10));
  const [sourceTreasuryId, setSource] = useState("");
  const [destinationTreasuryId, setDest] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmNow, setConfirmNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const invalid = validateTransferForm({ sourceTreasuryId, destinationTreasuryId, amount }, { both: t("errTransferBoth"), same: t("errTransferSame"), amount: t("errTransferAmount") });
    if (invalid) return setError(invalid);
    setSaving(true);
    try {
      const created = await createTransfer({ transferDate, sourceTreasuryId, destinationTreasuryId, amount: Number(amount).toFixed(2), notes: notes.trim() || undefined });
      if (confirmNow) await confirmTransfer(created.id);
      onCreated();
    } catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("errTransferCreate")); }
    finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={t("transferTitle")}>
      <div className="space-y-3">
        {error && <Alert variant="error">{error}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label>{t("openingDate")} *</Label><Input type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} /></div>
          <div className="space-y-1"><Label>{t("colAmount")} *</Label><Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="transfer-amount" /></div>
        </div>
        <div className="space-y-1">
          <Label>{t("transferFrom")} *</Label>
          <select value={sourceTreasuryId} onChange={(e) => setSource(e.target.value)} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" data-testid="transfer-source">
            <option value="">{t("choose")}</option>
            {treasuries.map((tr) => <option key={tr.id} value={tr.id}>{treasuryOptionLabel(tr, locale)}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label>{t("transferTo")} *</Label>
          <select value={destinationTreasuryId} onChange={(e) => setDest(e.target.value)} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" data-testid="transfer-dest">
            <option value="">{t("choose")}</option>
            {treasuries.map((tr) => <option key={tr.id} value={tr.id}>{treasuryOptionLabel(tr, locale)}</option>)}
          </select>
        </div>
        <div className="space-y-1"><Label>{t("formNotes")}</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmNow} onChange={(e) => setConfirmNow(e.target.checked)} />{t("confirmNow")}</label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button onClick={() => void submit()} disabled={saving} data-testid="transfer-save">{saving ? t("saving") : t("save")}</Button>
        </div>
      </div>
    </Modal>
  );
}
