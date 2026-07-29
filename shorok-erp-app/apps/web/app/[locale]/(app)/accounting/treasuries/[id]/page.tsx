"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useParams } from "next/navigation";
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
  getTreasury, getTreasuryStatement, postOpeningBalance, listOpeningBalances, reverseOpeningBalance,
  type TreasuryRow, type TreasuryStatementRow, type OpeningBalanceRow,
} from "../../../../../../lib/treasuries-client";
import { money, localizedName } from "../../../../../../lib/treasury-format";

const DOC_KEY: Record<string, string> = {
  TREASURY_OPENING: "docOpening", TREASURY_TRANSFER: "docTransfer", RECEIPT_VOUCHER: "docReceipt",
  PAYMENT_VOUCHER: "docPayment", EXPENSE: "docExpense", SALES_INVOICE: "docSalesInvoice", PURCHASE_INVOICE: "docPurchaseInvoice", MANUAL: "docManual",
};

export default function TreasuryDetailPage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("treasury");
  const params = useParams();
  const id = String(params.id);
  const canManage = useHasRole("OWNER");
  const [treasury, setTreasury] = useState<TreasuryRow | null>(null);
  const [rows, setRows] = useState<TreasuryStatementRow[]>([]);
  const [currentBalance, setCurrentBalance] = useState("0.00");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [openings, setOpenings] = useState<OpeningBalanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [openBal, setOpenBal] = useState(false);

  const docLabel = (key: string) => { const k = DOC_KEY[key]; return k ? t(k) : key; };

  const load = useCallback(async (opts: { append?: boolean; cursor?: string } = {}) => {
    setLoading(true);
    try {
      const [tr, stmt, obs] = await Promise.all([
        opts.append ? Promise.resolve(treasury) : getTreasury(id),
        getTreasuryStatement(id, { from: from || undefined, to: to || undefined, cursor: opts.cursor, limit: 25 }),
        opts.append ? Promise.resolve({ items: openings }) : listOpeningBalances(id),
      ]);
      if (tr) setTreasury(tr);
      setCurrentBalance(stmt.currentBalance);
      setNextCursor(stmt.nextCursor);
      setRows((prev) => (opts.append ? [...prev, ...stmt.items] : stmt.items));
      if (!opts.append) setOpenings((obs as { items: OpeningBalanceRow[] }).items);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("errLoad"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, from, to, locale, t]);

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id, from, to]);

  const doReverse = async (entryId: string) => {
    const reason = window.prompt(t("reverseReasonPrompt"));
    if (!reason) return;
    try { await reverseOpeningBalance(id, entryId, reason); await load(); }
    catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("errReverse")); }
  };

  if (loading && !treasury) return <Skeleton className="h-64 w-full" />;
  if (error && !treasury) return <Alert variant="error">{error}</Alert>;
  if (!treasury) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{localizedName(treasury.nameAr, treasury.nameEn, locale)}</h1>
            <Badge variant="neutral">{treasury.code}</Badge>
            {treasury.isDefault && <Badge variant="success">{t("badgeDefault")}</Badge>}
            {!treasury.active && <Badge variant="neutral">{t("statusInactive")}</Badge>}
          </div>
          <p className="text-sm text-textSecondary">
            {t("detailBranch")}: {localizedName(treasury.branchNameAr, treasury.branchNameEn, locale)} — {t("detailGlAccount")}: <span className="font-mono">{treasury.glAccountCode}</span> {localizedName(treasury.glAccountNameAr, treasury.glAccountNameEn, locale)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/${locale}/accounting/treasuries`}><Button variant="ghost">{t("back")}</Button></Link>
          {canManage && <Button onClick={() => setOpenBal(true)} data-testid="opening-balance-btn">{t("recordOpening")}</Button>}
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="grid grid-cols-3 gap-3">
        <Card><CardBody><p className="text-sm text-textSecondary">{t("currentBalance")}</p><p className="text-lg font-semibold tabular-nums" data-testid="treasury-balance">{money(currentBalance, locale)}</p></CardBody></Card>
        <Card><CardBody><p className="text-sm text-textSecondary">{t("movementCount")}</p><p className="text-lg font-semibold tabular-nums">{rows.length}</p></CardBody></Card>
        <Card><CardBody><p className="text-sm text-textSecondary">{t("colAllowNegative")}</p><p className="text-lg font-semibold">{treasury.allowNegativeBalance ? t("yes") : t("no")}</p></CardBody></Card>
      </div>

      {/* Opening balances lifecycle */}
      <Card>
        <CardHeader><CardTitle>{t("openingHistory")}</CardTitle></CardHeader>
        <CardBody>
          {openings.length === 0 ? (
            <p className="py-4 text-center text-textSecondary text-sm">—</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead><TR><TH>{t("colDate")}</TH><TH>{t("colEntryNo")}</TH><TH>{t("openingAmount")}</TH><TH>{t("counterpart")}</TH><TH>{t("colStatus")}</TH><TH>{t("colActions")}</TH></TR></THead>
                <TBody>
                  {openings.map((o) => (
                    <TR key={o.journalEntryId}>
                      <TD>{o.entryDate}</TD>
                      <TD className="font-mono text-xs">#{o.entryNumber}</TD>
                      <TD className="tabular-nums">{money(o.amount, locale)}</TD>
                      <TD className="text-xs">{o.counterpartAccountCode ? `${o.counterpartAccountCode} — ${localizedName(o.counterpartAccountNameAr ?? "", o.counterpartAccountNameEn, locale)}` : "—"}</TD>
                      <TD>{o.status === "REVERSED" ? <Badge variant="neutral">{t("reversed")}</Badge> : <Badge variant="success">{t("statusActive")}</Badge>}</TD>
                      <TD>
                        {canManage && o.status !== "REVERSED"
                          ? <button onClick={() => void doReverse(o.journalEntryId)} className="text-sm text-textSecondary hover:underline" data-testid="reverse-opening">{t("reverse")}</button>
                          : o.reversalEntryNumber ? <span className="text-xs text-textSecondary">#{o.reversalEntryNumber}</span> : "—"}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-end justify-between gap-3">
          <CardTitle>{t("statementTitle")}</CardTitle>
          <div className="flex items-end gap-2">
            <div className="space-y-1"><Label>{t("from")}</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="space-y-1"><Label>{t("to")}</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            <Button variant="secondary" onClick={() => void load()}>{t("filter")}</Button>
          </div>
        </CardHeader>
        <CardBody>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-textSecondary">{t("noMovements")}</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>{t("colDate")}</TH><TH>{t("colEntryNo")}</TH><TH>{t("colType")}</TH><TH>{t("colDesc")}</TH>
                      <TH>{t("colDebit")}</TH><TH>{t("colCredit")}</TH><TH>{t("colRunning")}</TH><TH>{t("colUser")}</TH><TH>{t("colDocument")}</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((r) => (
                      <TR key={r.journalLineId}>
                        <TD>{r.entryDate}</TD>
                        <TD className="font-mono text-xs">#{r.entryNumber}</TD>
                        <TD>{docLabel(r.documentType)}</TD>
                        <TD className="max-w-[240px] truncate" title={r.description}>{r.description}</TD>
                        <TD className="tabular-nums">{Number(r.debit) ? money(r.debit, locale) : "—"}</TD>
                        <TD className="tabular-nums">{Number(r.credit) ? money(r.credit, locale) : "—"}</TD>
                        <TD className="tabular-nums font-medium">{money(r.runningBalance, locale)}</TD>
                        <TD className="text-xs">{r.userName}</TD>
                        <TD><Link href={`/${locale}/accounting/journal?entry=${r.entryNumber}`} className="text-primary hover:underline text-xs">{t("entryLink")}</Link></TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              {nextCursor && (
                <div className="pt-3 text-center">
                  <Button variant="secondary" onClick={() => void load({ append: true, cursor: nextCursor })} data-testid="load-more">{t("loadMore")}</Button>
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>

      {openBal && <OpeningBalanceModal treasuryId={id} onClose={() => setOpenBal(false)} onPosted={async () => { setOpenBal(false); await load(); }} />}
    </div>
  );
}

function OpeningBalanceModal({ treasuryId, onClose, onPosted }: { treasuryId: string; onClose: () => void; onPosted: () => void }) {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("treasury");
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!amount || Number(amount) <= 0) return setError(t("errOpeningAmount"));
    setSaving(true);
    try {
      await postOpeningBalance(treasuryId, { entryDate, amount: Number(amount).toFixed(2), notes: notes.trim() || undefined });
      onPosted();
    } catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("errOpening")); }
    finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={t("openingTitle")}>
      <div className="space-y-3">
        {error && <Alert variant="error">{error}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label>{t("openingDate")} *</Label><Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} /></div>
          <div className="space-y-1"><Label>{t("openingAmount")} *</Label><Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="opening-amount" /></div>
        </div>
        <div className="space-y-1"><Label>{t("formNotes")}</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <p className="text-xs text-textSecondary">{t("openingHint")}</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button onClick={() => void submit()} disabled={saving} data-testid="opening-save">{saving ? t("openingPosting") : t("openingPost")}</Button>
        </div>
      </div>
    </Modal>
  );
}
