"use client";

import { useEffect, useState } from "react";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Modal } from "../../../../../components/ui/modal";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { useHasRole } from "../../../../../lib/auth";
import {
  listFixedAssets,
  getFixedAsset,
  getDepreciationSchedule,
  createFixedAsset,
  runDepreciation,
  type FixedAssetSummary,
  type FixedAssetDetail,
  type DepreciationSchedule,
} from "../../../../../lib/fixed-assets-client";
import { listAccounts, type AccountRow } from "../../../../../lib/accounts-client";
import { ApiClientError } from "../../../../../lib/api-client";

function fmt(v: string | number) {
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayFirstOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------
export default function FixedAssetsPage() {
  const canRecord = useHasRole("ACCOUNTANT");

  const [assets, setAssets] = useState<FixedAssetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // accounts for selects
  const [accounts, setAccounts] = useState<AccountRow[]>([]);

  // modals
  const [createOpen, setCreateOpen] = useState(false);
  const [depOpen, setDepOpen] = useState<FixedAssetSummary | null>(null);
  const [detailOpen, setDetailOpen] = useState<FixedAssetDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadAssets = () => {
    setLoading(true);
    setError(null);
    listFixedAssets()
      .then(setAssets)
      .catch((e) => setError(e instanceof ApiClientError ? e.payload.message_ar : "حدث خطأ"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadAssets();
    listAccounts().then(setAccounts).catch(() => {});
  }, []);

  const leafAccounts = accounts.filter((a) => a.isLeaf && a.active);

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    setDetailOpen(null);
    try {
      const detail = await getFixedAsset(id);
      setDetailOpen(detail);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message_ar : "حدث خطأ");
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="space-y-4 p-4" dir="rtl">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-textPrimary">الأصول الثابتة</h1>
        {canRecord && (
          <Button onClick={() => setCreateOpen(true)}>+ إضافة أصل ثابت</Button>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {/* Assets table */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>الكود</TH>
              <TH>الاسم</TH>
              <TH>تاريخ الاقتناء</TH>
              <TH>التكلفة</TH>
              <TH>إجمالي الاستهلاك</TH>
              <TH>القيمة الدفترية</TH>
              <TH>الحالة</TH>
              <TH>إجراءات</TH>
            </TR>
          </THead>
          <TBody>
            {assets.length === 0 && (
              <TR>
                <TD colSpan={8} className="text-center text-textSecondary py-8">
                  لا توجد أصول ثابتة مسجلة
                </TD>
              </TR>
            )}
            {assets.map((asset) => {
              const bv = parseFloat(asset.bookValue);
              return (
                <TR key={asset.id}>
                  <TD className="font-mono">{asset.code}</TD>
                  <TD>{asset.nameAr}</TD>
                  <TD dir="ltr">{asset.acquisitionDate}</TD>
                  <TD dir="ltr">{fmt(asset.acquisitionCost)}</TD>
                  <TD dir="ltr">{fmt(asset.totalDepreciated)}</TD>
                  <TD dir="ltr">
                    {bv > 0 ? (
                      <span className="text-success font-medium">{fmt(asset.bookValue)}</span>
                    ) : (
                      <span className="text-textSecondary text-xs">مستهلك بالكامل</span>
                    )}
                  </TD>
                  <TD>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        asset.active
                          ? "bg-success-bg text-success"
                          : "bg-background text-textSecondary"
                      }`}
                    >
                      {asset.active ? "نشط" : "غير نشط"}
                    </span>
                  </TD>
                  <TD>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openDetail(asset.id)}
                      >
                        تفاصيل
                      </Button>
                      {canRecord && asset.active && parseFloat(asset.bookValue) > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDepOpen(asset)}
                        >
                          استهلاك
                        </Button>
                      )}
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      {detailLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
          <Skeleton className="h-12 w-40" />
        </div>
      )}

      {/* Create modal */}
      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        accounts={leafAccounts}
        onCreated={() => {
          setCreateOpen(false);
          loadAssets();
        }}
      />

      {/* Depreciation modal */}
      {depOpen && (
        <DepreciationModal
          open={!!depOpen}
          asset={depOpen}
          onClose={() => setDepOpen(null)}
          onPosted={() => {
            setDepOpen(null);
            loadAssets();
          }}
        />
      )}

      {/* Detail modal */}
      {detailOpen && (
        <DetailModal
          open={!!detailOpen}
          asset={detailOpen}
          canRecord={canRecord}
          onClose={() => setDetailOpen(null)}
          onDepreciated={(updated) => {
            loadAssets();
            // Refresh detail
            getFixedAsset(updated).then(setDetailOpen).catch(() => {});
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create modal
// ---------------------------------------------------------------------------
interface CreateModalProps {
  open: boolean;
  onClose: () => void;
  accounts: AccountRow[];
  onCreated: () => void;
}

function CreateModal({ open, onClose, accounts, onCreated }: CreateModalProps) {
  const [form, setForm] = useState({
    code: "",
    nameAr: "",
    nameEn: "",
    acquisitionDate: new Date().toISOString().slice(0, 10),
    acquisitionCost: "",
    salvageValue: "0",
    usefulLifeMonths: "",
    assetAccountId: "",
    accumulatedDepAccountId: "",
    depreciationExpenseAccountId: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (field: string, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async () => {
    setError(null);
    if (!form.code || !form.nameAr || !form.acquisitionCost || !form.usefulLifeMonths ||
        !form.assetAccountId || !form.accumulatedDepAccountId || !form.depreciationExpenseAccountId) {
      setError("يرجى تعبئة جميع الحقول الإلزامية");
      return;
    }
    setSaving(true);
    try {
      await createFixedAsset({
        code: form.code,
        nameAr: form.nameAr,
        nameEn: form.nameEn || undefined,
        acquisitionDate: form.acquisitionDate,
        acquisitionCost: form.acquisitionCost,
        salvageValue: form.salvageValue || "0",
        usefulLifeMonths: parseInt(form.usefulLifeMonths, 10),
        assetAccountId: form.assetAccountId,
        accumulatedDepAccountId: form.accumulatedDepAccountId,
        depreciationExpenseAccountId: form.depreciationExpenseAccountId,
        notes: form.notes || undefined,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message_ar : "حدث خطأ أثناء الحفظ");
    } finally {
      setSaving(false);
    }
  };

  const accountOptions = accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {a.code} — {a.nameAr}
    </option>
  ));

  return (
    <Modal open={open} onClose={onClose} title="إضافة أصل ثابت جديد" className="w-full max-w-2xl">
      <div className="space-y-3" dir="rtl">
        {error && <Alert variant="error">{error}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-textSecondary mb-1">كود الأصل *</label>
            <Input value={form.code} onChange={(e) => set("code", e.target.value)} placeholder="FA-001" />
          </div>
          <div>
            <label className="block text-sm text-textSecondary mb-1">اسم الأصل بالعربية *</label>
            <Input value={form.nameAr} onChange={(e) => set("nameAr", e.target.value)} placeholder="سيارة نقل" />
          </div>
          <div>
            <label className="block text-sm text-textSecondary mb-1">تاريخ الاقتناء *</label>
            <Input type="date" value={form.acquisitionDate} onChange={(e) => set("acquisitionDate", e.target.value)} />
          </div>
          <div>
            <label className="block text-sm text-textSecondary mb-1">تكلفة الاقتناء *</label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={form.acquisitionCost}
              onChange={(e) => set("acquisitionCost", e.target.value)}
              placeholder="100000"
            />
          </div>
          <div>
            <label className="block text-sm text-textSecondary mb-1">القيمة المتبقية عند نهاية العمر</label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={form.salvageValue}
              onChange={(e) => set("salvageValue", e.target.value)}
              placeholder="0"
            />
          </div>
          <div>
            <label className="block text-sm text-textSecondary mb-1">العمر الافتراضي (بالشهور) *</label>
            <Input
              type="number"
              min="1"
              step="1"
              value={form.usefulLifeMonths}
              onChange={(e) => set("usefulLifeMonths", e.target.value)}
              placeholder="60"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm text-textSecondary mb-1">حساب الأصل *</label>
          <select
            className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
            value={form.assetAccountId}
            onChange={(e) => set("assetAccountId", e.target.value)}
          >
            <option value="">— اختر حساباً —</option>
            {accountOptions}
          </select>
        </div>

        <div>
          <label className="block text-sm text-textSecondary mb-1">حساب مجمع الاستهلاك *</label>
          <select
            className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
            value={form.accumulatedDepAccountId}
            onChange={(e) => set("accumulatedDepAccountId", e.target.value)}
          >
            <option value="">— اختر حساباً —</option>
            {accountOptions}
          </select>
        </div>

        <div>
          <label className="block text-sm text-textSecondary mb-1">حساب مصروف الاستهلاك *</label>
          <select
            className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
            value={form.depreciationExpenseAccountId}
            onChange={(e) => set("depreciationExpenseAccountId", e.target.value)}
          >
            <option value="">— اختر حساباً —</option>
            {accountOptions}
          </select>
        </div>

        <div>
          <label className="block text-sm text-textSecondary mb-1">ملاحظات</label>
          <textarea
            className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
            rows={2}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>إلغاء</Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "جاري الحفظ..." : "حفظ"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Depreciation modal
// ---------------------------------------------------------------------------
interface DepreciationModalProps {
  open: boolean;
  asset: FixedAssetSummary;
  onClose: () => void;
  onPosted: () => void;
}

function DepreciationModal({ open, asset, onClose, onPosted }: DepreciationModalProps) {
  const [periodDate, setPeriodDate] = useState(todayFirstOfMonth());
  const [postJournalEntry, setPostJournalEntry] = useState(true);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setSaving(true);
    try {
      await runDepreciation(asset.id, { periodDate, postJournalEntry, notes: notes || undefined });
      onPosted();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message_ar : "حدث خطأ");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`تسجيل استهلاك: ${asset.nameAr}`} className="w-full max-w-md">
      <div className="space-y-3" dir="rtl">
        {error && <Alert variant="error">{error}</Alert>}

        <div className="rounded-md bg-background px-4 py-3 text-sm space-y-1">
          <div>
            مبلغ الاستهلاك الشهري:{" "}
            <span className="font-semibold">{fmt(asset.monthlyDepreciation)} ج.م</span>
          </div>
          <div>
            القيمة الدفترية الحالية:{" "}
            <span className="font-semibold text-success">{fmt(asset.bookValue)} ج.م</span>
          </div>
        </div>

        <div>
          <label className="block text-sm text-textSecondary mb-1">فترة الاستهلاك *</label>
          <Input type="date" value={periodDate} onChange={(e) => setPeriodDate(e.target.value)} />
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="postJE"
            checked={postJournalEntry}
            onChange={(e) => setPostJournalEntry(e.target.checked)}
            className="rounded"
          />
          <label htmlFor="postJE" className="text-sm text-textPrimary">
            تسجيل قيد محاسبي تلقائياً
          </label>
        </div>

        <div>
          <label className="block text-sm text-textSecondary mb-1">ملاحظات</label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>إلغاء</Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "جاري التسجيل..." : "تسجيل الاستهلاك"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Detail modal
// ---------------------------------------------------------------------------
interface DetailModalProps {
  open: boolean;
  asset: FixedAssetDetail;
  canRecord: boolean;
  onClose: () => void;
  onDepreciated: (assetId: string) => void;
}

function DetailModal({ open, asset, canRecord, onClose, onDepreciated }: DetailModalProps) {
  const [scheduleData, setScheduleData] = useState<DepreciationSchedule | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [depOpen, setDepOpen] = useState(false);

  const loadSchedule = () => {
    if (scheduleData) {
      setShowSchedule((v) => !v);
      return;
    }
    setScheduleLoading(true);
    getDepreciationSchedule(asset.id)
      .then((s) => {
        setScheduleData(s);
        setShowSchedule(true);
      })
      .catch(() => {})
      .finally(() => setScheduleLoading(false));
  };

  return (
    <>
      <Modal open={open} onClose={onClose} title={`تفاصيل: ${asset.nameAr}`} className="w-full max-w-3xl">
        <div className="space-y-4" dir="rtl">
          {/* Asset info card */}
          <Card>
            <CardHeader>
              <CardTitle>بيانات الأصل</CardTitle>
            </CardHeader>
            <CardBody>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <InfoRow label="الكود" value={asset.code} />
                <InfoRow label="الاسم" value={asset.nameAr} />
                <InfoRow label="تاريخ الاقتناء" value={asset.acquisitionDate} />
                <InfoRow label="تكلفة الاقتناء" value={`${fmt(asset.acquisitionCost)} ج.م`} />
                <InfoRow label="القيمة المتبقية" value={`${fmt(asset.salvageValue)} ج.م`} />
                <InfoRow label="العمر الافتراضي" value={`${asset.usefulLifeMonths} شهر`} />
                <InfoRow label="الاستهلاك الشهري" value={`${fmt(asset.monthlyDepreciation)} ج.م`} />
                <InfoRow label="إجمالي الاستهلاك" value={`${fmt(asset.totalDepreciated)} ج.م`} />
                <InfoRow
                  label="القيمة الدفترية"
                  value={`${fmt(asset.bookValue)} ج.م`}
                  valueClass={parseFloat(asset.bookValue) > 0 ? "text-success font-semibold" : "text-textSecondary"}
                />
                <InfoRow
                  label="الحساب الأصل"
                  value={`${asset.assetAccount.code} — ${asset.assetAccount.nameAr}`}
                />
                <InfoRow
                  label="مجمع الاستهلاك"
                  value={`${asset.accumulatedDepAccount.code} — ${asset.accumulatedDepAccount.nameAr}`}
                />
                <InfoRow
                  label="مصروف الاستهلاك"
                  value={`${asset.depreciationExpenseAccount.code} — ${asset.depreciationExpenseAccount.nameAr}`}
                />
                {asset.notes && <InfoRow label="ملاحظات" value={asset.notes} fullWidth />}
              </div>
            </CardBody>
          </Card>

          {/* Posted depreciation entries */}
          <Card>
            <CardHeader>
              <CardTitle>قيود الاستهلاك المسجلة</CardTitle>
              <div className="flex gap-2">
                {canRecord && asset.active && parseFloat(asset.bookValue) > 0 && (
                  <Button size="sm" onClick={() => setDepOpen(true)}>+ استهلاك جديد</Button>
                )}
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {asset.depreciationEntries.length === 0 ? (
                <p className="px-4 py-4 text-sm text-textSecondary">لا توجد قيود استهلاك مسجلة بعد</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>الفترة</TH>
                      <TH>المبلغ</TH>
                      <TH>قيد محاسبي</TH>
                      <TH>ملاحظات</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {asset.depreciationEntries.map((e) => (
                      <TR key={e.id}>
                        <TD dir="ltr">{e.periodDate}</TD>
                        <TD dir="ltr">{fmt(e.amount)}</TD>
                        <TD>
                          {e.journalEntryId ? (
                            <span className="text-success text-xs">مُسجَّل</span>
                          ) : (
                            <span className="text-textSecondary text-xs">—</span>
                          )}
                        </TD>
                        <TD className="text-textSecondary">{e.notes ?? "—"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>

          {/* Schedule section */}
          <div>
            <Button variant="ghost" size="sm" onClick={loadSchedule} disabled={scheduleLoading}>
              {scheduleLoading ? "جاري التحميل..." : showSchedule ? "إخفاء جدول الاستهلاك" : "عرض جدول الاستهلاك"}
            </Button>

            {showSchedule && scheduleData && (
              <div className="mt-2">
                <p className="text-sm text-textSecondary mb-2">
                  إجمالي الفترات: {scheduleData.totalPeriods} | القسط الشهري: {fmt(scheduleData.monthlyAmount)} ج.م
                </p>
                <div className="max-h-64 overflow-y-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>#</TH>
                        <TH>الفترة</TH>
                        <TH>المبلغ</TH>
                        <TH>الحالة</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {scheduleData.schedule.map((p, idx) => (
                        <TR key={p.periodDate}>
                          <TD className="text-textSecondary">{idx + 1}</TD>
                          <TD dir="ltr">{p.periodDate}</TD>
                          <TD dir="ltr">{fmt(p.amount)}</TD>
                          <TD>
                            {p.posted ? (
                              <span className="text-success text-xs font-medium">مُسجَّل</span>
                            ) : (
                              <span className="text-textSecondary text-xs">لم يُسجَّل</span>
                            )}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* Nested depreciation modal */}
      {depOpen && (
        <DepreciationModal
          open={depOpen}
          asset={asset}
          onClose={() => setDepOpen(false)}
          onPosted={() => {
            setDepOpen(false);
            setScheduleData(null);
            setShowSchedule(false);
            onDepreciated(asset.id);
          }}
        />
      )}
    </>
  );
}

function InfoRow({
  label,
  value,
  valueClass,
  fullWidth,
}: {
  label: string;
  value: string;
  valueClass?: string;
  fullWidth?: boolean;
}) {
  return (
    <div className={fullWidth ? "col-span-2" : ""}>
      <span className="text-textSecondary">{label}: </span>
      <span className={valueClass ?? "text-textPrimary"}>{value}</span>
    </div>
  );
}
