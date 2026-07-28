"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
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
  listTreasuries,
  createTreasury,
  activateTreasury,
  deactivateTreasury,
  type TreasuryRow,
} from "../../../../../lib/treasuries-client";

function money(v: string | number) {
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function TreasuriesPage() {
  const locale = useLocale() as AppLocale;
  const canManage = useHasRole("OWNER"); // treasury management is OWNER-only
  const [rows, setRows] = useState<TreasuryRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, b] = await Promise.all([listTreasuries(showInactive), listAllBranches().catch(() => [])]);
      setRows(t.items);
      setBranches((b as BranchRow[]).filter((x) => x.active));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر تحميل الخزائن.");
    } finally {
      setLoading(false);
    }
  }, [locale, showInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleActive = async (t: TreasuryRow) => {
    try {
      if (t.active) await deactivateTreasury(t.id);
      else await activateTreasury(t.id);
      await load();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر تغيير الحالة.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">الخزائن</h1>
          <p className="text-sm text-textSecondary">إدارة خزائن النقدية والبنوك — الأرصدة محسوبة من دفتر الأستاذ.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/${locale}/accounting/treasuries/transfers`}>
            <Button variant="secondary">تحويلات الخزائن</Button>
          </Link>
          {canManage && (
            <Button onClick={() => setOpen(true)} data-testid="add-treasury">
              إضافة خزنة
            </Button>
          )}
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>قائمة الخزائن</CardTitle>
          <label className="flex items-center gap-2 text-sm text-textSecondary">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            إظهار الموقوفة
          </label>
        </CardHeader>
        <CardBody>
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-textSecondary">لا توجد خزائن بعد. اضغط «إضافة خزنة» للبدء.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>الكود</TH>
                    <TH>اسم الخزنة</TH>
                    <TH>الفرع</TH>
                    <TH>حساب الأستاذ</TH>
                    <TH>الرصيد الحالي</TH>
                    <TH>السماح بالسالب</TH>
                    <TH>افتراضية</TH>
                    <TH>الحالة</TH>
                    <TH>الإجراءات</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((t) => (
                    <TR key={t.id} data-testid="treasury-row" data-code={t.code}>
                      <TD className="font-mono text-xs">{t.code}</TD>
                      <TD className="font-medium">{t.nameAr}</TD>
                      <TD>{t.branchNameAr}</TD>
                      <TD className="font-mono text-xs">{t.glAccountCode}</TD>
                      <TD className="tabular-nums">{money(t.balance)}</TD>
                      <TD>{t.allowNegativeBalance ? "نعم" : "لا"}</TD>
                      <TD>{t.isDefault ? <Badge variant="success">افتراضية</Badge> : "—"}</TD>
                      <TD>{t.active ? <Badge variant="success">نشطة</Badge> : <Badge variant="neutral">موقوفة</Badge>}</TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          <Link href={`/${locale}/accounting/treasuries/${t.id}`} className="text-primary hover:underline text-sm">
                            كشف الحركة
                          </Link>
                          {canManage && !t.isDefault && (
                            <button onClick={() => void toggleActive(t)} className="text-sm text-textSecondary hover:underline">
                              {t.active ? "إيقاف" : "إعادة تنشيط"}
                            </button>
                          )}
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

      {open && (
        <CreateTreasuryModal
          branches={branches}
          onClose={() => setOpen(false)}
          onCreated={async () => {
            setOpen(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

function CreateTreasuryModal({
  branches,
  onClose,
  onCreated,
}: {
  branches: BranchRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const locale = useLocale() as AppLocale;
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
    if (!nameAr.trim()) return setError("اسم الخزنة بالعربية مطلوب.");
    if (!branchId) return setError("اختر الفرع.");
    setSaving(true);
    try {
      await createTreasury({
        nameAr: nameAr.trim(),
        nameEn: nameEn.trim() || undefined,
        code: code.trim() || undefined,
        branchId,
        treasuryType,
        allowNegativeBalance: allowNegative,
        isDefault,
        notes: notes.trim() || undefined,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر إنشاء الخزنة.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="إضافة خزنة">
      <div className="space-y-3">
        {error && <Alert variant="error">{error}</Alert>}
        <div className="space-y-1">
          <Label>اسم الخزنة بالعربية *</Label>
          <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder="مثال: خزنة المبيعات" data-testid="treasury-nameAr" autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>الاسم بالإنجليزية</Label>
            <Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>كود الخزنة (اختياري)</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="يُولّد تلقائياً" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>الفرع *</Label>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" data-testid="treasury-branch">
              <option value="">— اختر —</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.nameAr}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>النوع</Label>
            <select value={treasuryType} onChange={(e) => setTreasuryType(e.target.value as "CASH" | "BANK")} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
              <option value="CASH">نقدية (خزينة)</option>
              <option value="BANK">بنك</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-6 pt-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowNegative} onChange={(e) => setAllowNegative(e.target.checked)} />
            السماح بالرصيد السالب
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            خزنة افتراضية
          </label>
        </div>
        <div className="space-y-1">
          <Label>ملاحظات</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <p className="text-xs text-textSecondary">سيتم إنشاء حساب أستاذ مستقل للخزنة تلقائياً وربطه بها.</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>إلغاء</Button>
          <Button onClick={() => void submit()} disabled={saving} data-testid="treasury-save">
            {saving ? "جارٍ الحفظ…" : "حفظ"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
