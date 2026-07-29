"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { Modal } from "../../../../../components/ui/modal";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { useHasRole } from "../../../../../lib/auth";
import { ApiClientError } from "../../../../../lib/api-client";
import { listAllBranches, type BranchRow } from "../../../../../lib/admin-client";
import {
  listTreasuries, createTreasury, updateTreasury, activateTreasury, deactivateTreasury,
  type TreasuryRow,
} from "../../../../../lib/treasuries-client";
import { money, validateTreasuryForm } from "../../../../../lib/treasury-format";

export default function TreasuriesPage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("treasury");
  const canManage = useHasRole("OWNER");
  const [rows, setRows] = useState<TreasuryRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [openCreate, setOpenCreate] = useState(false);
  const [editRow, setEditRow] = useState<TreasuryRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tr, b] = await Promise.all([listTreasuries(showInactive), listAllBranches().catch(() => [])]);
      setRows(tr.items);
      setBranches((b as BranchRow[]).filter((x) => x.active));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("errLoad"));
    } finally {
      setLoading(false);
    }
  }, [locale, showInactive, t]);

  useEffect(() => { void load(); }, [load]);

  const toggleActive = async (row: TreasuryRow) => {
    try {
      if (row.active) await deactivateTreasury(row.id); else await activateTreasury(row.id);
      await load();
    } catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("errStatus")); }
  };
  const makeDefault = async (row: TreasuryRow) => {
    try { await updateTreasury(row.id, { isDefault: true }); await load(); }
    catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("errUpdate")); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-textSecondary">{t("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/${locale}/accounting/treasuries/transfers`}><Button variant="secondary">{t("transfersLink")}</Button></Link>
          {canManage && <Button onClick={() => setOpenCreate(true)} data-testid="add-treasury">{t("add")}</Button>}
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>{t("listTitle")}</CardTitle>
          <label className="flex items-center gap-2 text-sm text-textSecondary">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            {t("showInactive")}
          </label>
        </CardHeader>
        <CardBody>
          {loading ? <Skeleton className="h-40 w-full" /> : rows.length === 0 ? (
            <p className="py-8 text-center text-textSecondary">{t("empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>{t("colCode")}</TH><TH>{t("colName")}</TH><TH>{t("colBranch")}</TH><TH>{t("colGlAccount")}</TH>
                    <TH>{t("colBalance")}</TH><TH>{t("colAllowNegative")}</TH><TH>{t("colDefault")}</TH><TH>{t("colStatus")}</TH><TH>{t("colActions")}</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.id} data-testid="treasury-row" data-code={row.code}>
                      <TD className="font-mono text-xs">{row.code}</TD>
                      <TD className="font-medium">{row.nameAr}</TD>
                      <TD>{row.branchNameAr}</TD>
                      <TD className="font-mono text-xs">{row.glAccountCode}</TD>
                      <TD className="tabular-nums">{money(row.balance)}</TD>
                      <TD>{row.allowNegativeBalance ? t("yes") : t("no")}</TD>
                      <TD>{row.isDefault ? <Badge variant="success">{t("badgeDefault")}</Badge> : "—"}</TD>
                      <TD>{row.active ? <Badge variant="success">{t("statusActive")}</Badge> : <Badge variant="neutral">{t("statusInactive")}</Badge>}</TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          <Link href={`/${locale}/accounting/treasuries/${row.id}`} className="text-primary hover:underline text-sm">{t("statement")}</Link>
                          {canManage && <button onClick={() => setEditRow(row)} className="text-sm text-textSecondary hover:underline">{t("edit")}</button>}
                          {canManage && !row.isDefault && row.active && <button onClick={() => void makeDefault(row)} className="text-sm text-textSecondary hover:underline">{t("setDefault")}</button>}
                          {canManage && !row.isDefault && <button onClick={() => void toggleActive(row)} className="text-sm text-textSecondary hover:underline">{row.active ? t("deactivate") : t("reactivate")}</button>}
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

      {openCreate && <CreateTreasuryModal branches={branches} onClose={() => setOpenCreate(false)} onCreated={async () => { setOpenCreate(false); await load(); }} />}
      {editRow && <EditTreasuryModal row={editRow} onClose={() => setEditRow(null)} onSaved={async () => { setEditRow(null); await load(); }} />}
    </div>
  );
}

function CreateTreasuryModal({ branches, onClose, onCreated }: { branches: BranchRow[]; onClose: () => void; onCreated: () => void }) {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("treasury");
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [code, setCode] = useState("");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [treasuryType, setTreasuryType] = useState<"CASH" | "BANK">("CASH");
  const [allowNegative, setAllowNegative] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const invalid = validateTreasuryForm({ nameAr, branchId }, { nameRequired: t("errNameRequired"), branchRequired: t("errBranchRequired") });
    if (invalid) return setError(invalid);
    setSaving(true);
    try {
      await createTreasury({ nameAr: nameAr.trim(), nameEn: nameEn.trim() || undefined, code: code.trim() || undefined, branchId, treasuryType, allowNegativeBalance: allowNegative, isDefault, notes: notes.trim() || undefined });
      onCreated();
    } catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("errCreate")); }
    finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={t("add")}>
      <div className="space-y-3">
        {error && <Alert variant="error">{error}</Alert>}
        <div className="space-y-1">
          <Label>{t("formNameAr")} *</Label>
          <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder={t("namePlaceholder")} data-testid="treasury-nameAr" autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label>{t("formNameEn")}</Label><Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} /></div>
          <div className="space-y-1"><Label>{t("formCode")}</Label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("formCodePlaceholder")} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>{t("formBranch")} *</Label>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" data-testid="treasury-branch">
              <option value="">{t("choose")}</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.nameAr}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label>{t("formType")}</Label>
            <select value={treasuryType} onChange={(e) => setTreasuryType(e.target.value as "CASH" | "BANK")} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
              <option value="CASH">{t("typeCash")}</option>
              <option value="BANK">{t("typeBank")}</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-6 pt-1">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allowNegative} onChange={(e) => setAllowNegative(e.target.checked)} />{t("formAllowNegative")}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />{t("formDefault")}</label>
        </div>
        <div className="space-y-1"><Label>{t("formNotes")}</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <p className="text-xs text-textSecondary">{t("glAutoHint")}</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button onClick={() => void submit()} disabled={saving} data-testid="treasury-save">{saving ? t("saving") : t("save")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function EditTreasuryModal({ row, onClose, onSaved }: { row: TreasuryRow; onClose: () => void; onSaved: () => void }) {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("treasury");
  const [nameAr, setNameAr] = useState(row.nameAr);
  const [nameEn, setNameEn] = useState(row.nameEn ?? "");
  const [notes, setNotes] = useState(row.notes ?? "");
  const [allowNegative, setAllowNegative] = useState(row.allowNegativeBalance);
  const [isDefault, setIsDefault] = useState(row.isDefault);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!nameAr.trim()) return setError(t("errNameRequired"));
    setSaving(true);
    try {
      const body: Record<string, unknown> = { nameAr: nameAr.trim(), nameEn: nameEn.trim() || null, notes: notes.trim() || null, allowNegativeBalance: allowNegative };
      if (isDefault && !row.isDefault) body.isDefault = true;
      await updateTreasury(row.id, body);
      onSaved();
    } catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("errUpdate")); }
    finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={t("editTitle")}>
      <div className="space-y-3">
        {error && <Alert variant="error">{error}</Alert>}
        <div className="space-y-1"><Label>{t("formNameAr")} *</Label><Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} data-testid="edit-nameAr" /></div>
        <div className="space-y-1"><Label>{t("formNameEn")}</Label><Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} /></div>
        <div className="space-y-1"><Label>{t("formNotes")}</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <div className="flex items-center gap-6 pt-1">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allowNegative} onChange={(e) => setAllowNegative(e.target.checked)} />{t("formAllowNegative")}</label>
          {!row.isDefault && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />{t("formDefault")}</label>}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button onClick={() => void submit()} disabled={saving} data-testid="edit-save">{saving ? t("saving") : t("save")}</Button>
        </div>
      </div>
    </Modal>
  );
}
