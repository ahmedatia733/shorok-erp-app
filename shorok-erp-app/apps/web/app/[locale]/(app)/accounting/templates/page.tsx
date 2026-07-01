"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Modal } from "../../../../../components/ui/modal";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { useHasRole } from "../../../../../lib/auth";
import {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  type JournalTemplate,
} from "../../../../../lib/journal-templates-client";
import { listAccounts, type AccountRow } from "../../../../../lib/accounts-client";
import { listCustomers, type CustomerRow } from "../../../../../lib/customers-client";
import { listSuppliers, type SupplierRow } from "../../../../../lib/suppliers-client";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TemplateLine {
  category: string;
  accountId: string;
  entityLabel: string;
  note: string;
  debit: string;
  credit: string;
}

// ─── Category definitions ─────────────────────────────────────────────────────

const CATEGORIES = [
  { id: "banks",     label: "البنوك",               special: false },
  { id: "cash",      label: "الصندوق والنقدية",      special: false },
  { id: "ar",        label: "الذمم المدينة",         special: false },
  { id: "ap",        label: "الذمم الدائنة",         special: false },
  { id: "revenue",   label: "الإيرادات",             special: false },
  { id: "cogs",      label: "تكلفة المبيعات",        special: false },
  { id: "expense",   label: "المصروفات",             special: false },
  { id: "fixed",     label: "الأصول الثابتة",        special: false },
  { id: "inventory", label: "المخزون والبضاعة",      special: false },
  { id: "tax",       label: "الضرائب",               special: false },
  { id: "equity",    label: "رأس المال",             special: false },
  { id: "customers", label: "العملاء",               special: true  },
  { id: "suppliers", label: "الموردون",              special: true  },
  { id: "all",       label: "جميع الحسابات",         special: false },
];

function filterAccounts(cat: string, accounts: AccountRow[]): AccountRow[] {
  if (cat === "customers" || cat === "suppliers") return [];
  const n = (a: AccountRow) => a.nameAr;
  const tests: Record<string, (a: AccountRow) => boolean> = {
    banks:     (a) => /بنك/.test(n(a)),
    cash:      (a) => /صندوق|نقد/.test(n(a)),
    ar:        (a) => a.category === "ASSET" && /مدين|ذمم|عميل/.test(n(a)),
    ap:        (a) => a.category === "LIABILITY" && /دائن|مورد|ذمم/.test(n(a)),
    revenue:   (a) => a.category === "REVENUE",
    cogs:      (a) => a.category === "COST_OF_SALES",
    expense:   (a) => a.category === "EXPENSE",
    fixed:     (a) => a.accountType === "FIXED_ASSET",
    inventory: (a) => /مخزون|بضاع|سلع/.test(n(a)),
    tax:       (a) => /ضريب/.test(n(a)),
    equity:    (a) => a.category === "EQUITY",
    all:       () => true,
  };
  const test = tests[cat] ?? (() => true);
  return accounts.filter((a) => a.isLeaf && a.active && test(a));
}

function getAllLeafs(accounts: AccountRow[]): AccountRow[] {
  const out: AccountRow[] = [];
  for (const a of accounts) {
    if (a.isLeaf && a.active) out.push(a);
    if (a.children) out.push(...getAllLeafs(a.children));
  }
  return out;
}

function emptyLine(): TemplateLine {
  return { category: "", accountId: "", entityLabel: "", note: "", debit: "", credit: "" };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TemplatesPage() {
  const locale = useLocale() as AppLocale;
  const isOwner = useHasRole();
  const canCreate = useHasRole("ACCOUNTANT");

  const [templates, setTemplates] = useState<JournalTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<JournalTemplate | null>(null);
  const [leafAccounts, setLeafAccounts] = useState<AccountRow[]>([]);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [lines, setLines] = useState<TemplateLine[]>([emptyLine(), emptyLine()]);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    try {
      setTemplates(await listTemplates());
    } catch {
      setError("فشل تحميل قوالب القيود");
    }
  }, []);

  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  useEffect(() => {
    if (!modalOpen || leafAccounts.length > 0) return;
    void Promise.all([listAccounts(), listCustomers(), listSuppliers()]).then(
      ([accs, custs, supps]) => {
        setLeafAccounts(getAllLeafs(accs));
        setCustomers(custs.filter((c) => c.active));
        setSuppliers(supps.filter((s) => s.active));
      },
    );
  }, [modalOpen, leafAccounts.length]);

  function openCreate() {
    setEditingTemplate(null);
    setFormName("");
    setFormDescription("");
    setLines([emptyLine(), emptyLine()]);
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(tmpl: JournalTemplate) {
    setEditingTemplate(tmpl);
    setFormName(tmpl.name);
    setFormDescription(tmpl.description ?? "");
    const mapped: TemplateLine[] = tmpl.lines.map((l) => ({
      category: "all",
      accountId: l.accountId,
      entityLabel: `${l.accountCode} — ${locale === "ar" ? l.accountNameAr : l.accountNameEn}`,
      note: l.note ?? "",
      debit: l.type === "debit" ? (l.amount ?? "") : "",
      credit: l.type === "credit" ? (l.amount ?? "") : "",
    }));
    setLines(mapped.length > 0 ? mapped : [emptyLine(), emptyLine()]);
    setFormError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingTemplate(null);
  }

  function updateLine(idx: number, patch: Partial<TemplateLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function handleCategoryChange(idx: number, cat: string) {
    updateLine(idx, { category: cat, accountId: "", entityLabel: "" });
  }

  function handleAccountChange(idx: number, accountId: string) {
    const acc = leafAccounts.find((a) => a.id === accountId);
    updateLine(idx, {
      accountId,
      entityLabel: acc ? `${acc.code} — ${acc.nameAr}` : "",
    });
  }

  function handleCustomerSelect(idx: number, customerId: string) {
    const cust = customers.find((c) => c.id === customerId);
    if (!cust) return;
    const arAcc = leafAccounts.find(
      (a) => a.category === "ASSET" && /ذمم مدين|مدينون|حساب.*عميل/.test(a.nameAr),
    );
    updateLine(idx, {
      entityLabel: `${cust.code} — ${cust.nameAr}`,
      note: (lines[idx]?.note) || `${cust.code} — ${cust.nameAr}`,
      accountId: arAcc?.id ?? "",
    });
  }

  function handleSupplierSelect(idx: number, supplierId: string) {
    const supp = suppliers.find((s) => s.id === supplierId);
    if (!supp) return;
    const apAcc = leafAccounts.find(
      (a) => a.category === "LIABILITY" && /ذمم دائن|دائنون|حساب.*مورد/.test(a.nameAr),
    );
    updateLine(idx, {
      entityLabel: supp.nameAr,
      note: (lines[idx]?.note) || supp.nameAr,
      accountId: apAcc?.id ?? "",
    });
  }

  function handleDebitChange(idx: number, val: string) {
    setLines((prev) =>
      prev.map((l, i) => (i === idx ? { ...l, debit: val, credit: val ? "" : l.credit } : l)),
    );
  }

  function handleCreditChange(idx: number, val: string) {
    setLines((prev) =>
      prev.map((l, i) => (i === idx ? { ...l, credit: val, debit: val ? "" : l.debit } : l)),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormLoading(true);
    setFormError(null);

    const validLines = lines.filter((l) => l.accountId && (l.debit || l.credit));
    if (validLines.length === 0) {
      setFormError("أضف سطراً واحداً على الأقل مع حساب ومبلغ (أو اتركه بدون مبلغ ليُطلب عند الاستخدام)");
      // allow lines without amount
    }

    // Lines without amount are allowed (filled at use-time)
    const submitLines = lines
      .filter((l) => l.accountId)
      .map((l, idx) => ({
        accountId: l.accountId,
        type: l.credit ? ("credit" as const) : ("debit" as const),
        amount: (l.debit || l.credit) || undefined,
        note: l.note || undefined,
        sortOrder: idx,
      }));

    if (submitLines.length === 0) {
      setFormError("أضف سطراً واحداً على الأقل وحدد الحساب");
      setFormLoading(false);
      return;
    }

    try {
      if (editingTemplate) {
        await updateTemplate(editingTemplate.id, {
          name: formName,
          description: formDescription || undefined,
          lines: submitLines,
        });
      } else {
        await createTemplate({
          name: formName,
          description: formDescription || undefined,
          lines: submitLines,
        });
      }
      closeModal();
      await loadTemplates();
    } catch {
      setFormError("حدث خطأ أثناء الحفظ");
    } finally {
      setFormLoading(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteTemplate(id);
      setDeleteConfirmId(null);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch {
      setError("فشل حذف القالب");
    }
  }

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Live totals
  const totalDebit = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const diff = Math.abs(totalDebit - totalCredit);
  const isBalanced = diff < 0.005;

  const selectCls =
    "w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary";
  const amountCls =
    "w-full rounded border px-2 py-1.5 text-sm text-end tabular-nums bg-background focus:outline-none focus:ring-1";

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">قوالب القيود</h1>
        {canCreate && <Button onClick={openCreate}>+ قالب جديد</Button>}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="space-y-3">
        {templates.length === 0 && (
          <p className="text-textSecondary text-sm">لا توجد قوالب بعد.</p>
        )}
        {templates.map((tmpl) => {
          const expanded = expandedIds.has(tmpl.id);
          const confirmingDelete = deleteConfirmId === tmpl.id;
          const debitLines = tmpl.lines.filter((l) => l.type === "debit");
          const creditLines = tmpl.lines.filter((l) => l.type === "credit");
          const debitSum = debitLines.reduce((s, l) => s + parseFloat(l.amount ?? "0"), 0);
          const creditSum = creditLines.reduce((s, l) => s + parseFloat(l.amount ?? "0"), 0);

          return (
            <Card key={tmpl.id}>
              <CardHeader>
                <button
                  type="button"
                  className="flex items-center gap-4 text-start flex-1 min-w-0"
                  onClick={() => toggleExpand(tmpl.id)}
                >
                  <CardTitle className="truncate">{tmpl.name}</CardTitle>
                  {tmpl.description && (
                    <span className="text-textSecondary text-sm truncate">{tmpl.description}</span>
                  )}
                  <span className="text-textSecondary text-xs shrink-0">
                    {debitLines.length} مدين · {creditLines.length} دائن
                  </span>
                  <span className="text-textSecondary text-sm">{expanded ? "▾" : "▸"}</span>
                </button>
                <div className="flex items-center gap-2 shrink-0">
                  {canCreate && (
                    <Button size="sm" variant="ghost" onClick={() => openEdit(tmpl)}>
                      تعديل
                    </Button>
                  )}
                  {isOwner && (
                    confirmingDelete ? (
                      <div className="flex items-center gap-1 text-sm">
                        <span>تأكيد الحذف؟</span>
                        <Button size="sm" variant="danger" onClick={() => void handleDelete(tmpl.id)}>
                          نعم
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleteConfirmId(null)}>
                          لا
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setDeleteConfirmId(tmpl.id)}>
                        حذف
                      </Button>
                    )
                  )}
                </div>
              </CardHeader>

              {expanded && (
                <CardBody className="p-0 overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH className="w-8">#</TH>
                        <TH>الحساب</TH>
                        <TH>البيان</TH>
                        <TH className="text-end text-red-700">مدين</TH>
                        <TH className="text-end text-green-700">دائن</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {tmpl.lines.map((line, i) => (
                        <TR key={line.id}>
                          <TD className="text-textSecondary text-xs">{i + 1}</TD>
                          <TD>
                            <span className="font-mono text-xs text-textSecondary me-1">
                              {line.accountCode}
                            </span>
                            {locale === "ar" ? line.accountNameAr : line.accountNameEn}
                          </TD>
                          <TD className="text-textSecondary text-sm">{line.note ?? "—"}</TD>
                          <TD className="text-end font-mono text-sm">
                            {line.type === "debit" && (
                              <span className="text-red-700 font-medium">
                                {line.amount ?? <span className="text-textSecondary text-xs">يُحدد عند الاستخدام</span>}
                              </span>
                            )}
                          </TD>
                          <TD className="text-end font-mono text-sm">
                            {line.type === "credit" && (
                              <span className="text-green-700 font-medium">
                                {line.amount ?? <span className="text-textSecondary text-xs">يُحدد عند الاستخدام</span>}
                              </span>
                            )}
                          </TD>
                        </TR>
                      ))}
                      {/* Totals */}
                      <TR>
                        <TD />
                        <TD colSpan={2}>
                          <span className="text-xs text-textSecondary font-semibold">الإجمالي</span>
                        </TD>
                        <TD className="text-end font-mono font-bold text-red-700">
                          {debitSum > 0 ? debitSum.toFixed(2) : ""}
                        </TD>
                        <TD className="text-end font-mono font-bold text-green-700">
                          {creditSum > 0 ? creditSum.toFixed(2) : ""}
                        </TD>
                      </TR>
                    </TBody>
                  </Table>
                </CardBody>
              )}
            </Card>
          );
        })}
      </div>

      {/* ─── Create / Edit Modal ─────────────────────────────────────────── */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editingTemplate ? "تعديل قالب" : "قالب جديد"}
        className="max-w-5xl w-[95vw]"
      >
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5" dir="rtl">
          {formError && <Alert variant="error">{formError}</Alert>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1 font-medium">اسم القالب</label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                required
                maxLength={200}
                placeholder="مثال: قيد رواتب شهري"
              />
            </div>
            <div>
              <label className="block text-sm mb-1 font-medium">الوصف (اختياري)</label>
              <Input
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                maxLength={500}
                placeholder="وصف مختصر للقالب"
              />
            </div>
          </div>

          {/* ─── Lines table ─────────────────────────────────────────────── */}
          <div className="border border-border rounded overflow-hidden">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-surface border-b-2 border-border">
                  <th className="px-2 py-2 text-center text-xs text-textSecondary font-semibold w-8">#</th>
                  <th className="px-2 py-2 text-start text-xs text-textSecondary font-semibold w-36">القائمة</th>
                  <th className="px-2 py-2 text-start text-xs text-textSecondary font-semibold">الحساب</th>
                  <th className="px-2 py-2 text-start text-xs text-textSecondary font-semibold">البيان</th>
                  <th className="px-2 py-2 text-center text-xs font-bold text-red-700 w-28">مدين</th>
                  <th className="px-2 py-2 text-center text-xs font-bold text-green-700 w-28">دائن</th>
                  <th className="w-7" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => {
                  const catDef = CATEGORIES.find((c) => c.id === line.category);
                  const isCustomers = line.category === "customers";
                  const isSuppliers = line.category === "suppliers";
                  const isSpecial = isCustomers || isSuppliers;
                  const accountOptions = line.category && !isSpecial
                    ? filterAccounts(line.category, leafAccounts)
                    : [];

                  return (
                    <tr key={idx} className="border-b border-border last:border-0 hover:bg-surface/60 transition-colors">
                      {/* # */}
                      <td className="px-2 py-2 text-center text-xs text-textSecondary select-none">
                        {idx + 1}
                      </td>

                      {/* القائمة */}
                      <td className="px-1.5 py-1.5">
                        <select
                          className={selectCls}
                          value={line.category}
                          onChange={(e) => handleCategoryChange(idx, e.target.value)}
                        >
                          <option value="">— اختر القائمة —</option>
                          {CATEGORIES.map((c) => (
                            <option key={c.id} value={c.id}>{c.label}</option>
                          ))}
                        </select>
                      </td>

                      {/* الحساب */}
                      <td className="px-1.5 py-1.5">
                        {!line.category ? (
                          <span className="text-xs text-textSecondary italic">اختر القائمة أولاً</span>
                        ) : isCustomers ? (
                          <div className="space-y-1">
                            <select
                              className={selectCls}
                              value=""
                              onChange={(e) => handleCustomerSelect(idx, e.target.value)}
                            >
                              <option value="">— اختر العميل —</option>
                              {customers.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.code} — {c.nameAr}
                                </option>
                              ))}
                            </select>
                            {line.entityLabel && (
                              <div className="text-xs text-primary font-medium px-1">
                                ✓ {line.entityLabel}
                              </div>
                            )}
                          </div>
                        ) : isSuppliers ? (
                          <div className="space-y-1">
                            <select
                              className={selectCls}
                              value=""
                              onChange={(e) => handleSupplierSelect(idx, e.target.value)}
                            >
                              <option value="">— اختر المورد —</option>
                              {suppliers.map((s) => (
                                <option key={s.id} value={s.id}>{s.nameAr}</option>
                              ))}
                            </select>
                            {line.entityLabel && (
                              <div className="text-xs text-primary font-medium px-1">
                                ✓ {line.entityLabel}
                              </div>
                            )}
                          </div>
                        ) : (
                          <select
                            className={selectCls}
                            value={line.accountId}
                            onChange={(e) => handleAccountChange(idx, e.target.value)}
                          >
                            <option value="">— اختر الحساب —</option>
                            {accountOptions.length === 0 && line.category !== "all" ? (
                              <option disabled value="">لا توجد حسابات في هذه القائمة</option>
                            ) : null}
                            {accountOptions.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.code} — {a.nameAr}
                              </option>
                            ))}
                          </select>
                        )}
                        {/* Warning: special category selected but no account resolved */}
                        {isSpecial && line.entityLabel && !line.accountId && (
                          <div className="text-xs text-amber-600 px-1 mt-0.5">
                            ⚠ لم يُعثر على حساب — غيّر القائمة لـ «الذمم المدينة» واختر يدوياً
                          </div>
                        )}
                      </td>

                      {/* البيان */}
                      <td className="px-1.5 py-1.5">
                        <input
                          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                          type="text"
                          placeholder="البيان..."
                          value={line.note}
                          onChange={(e) => updateLine(idx, { note: e.target.value })}
                          maxLength={200}
                        />
                      </td>

                      {/* مدين */}
                      <td className="px-1.5 py-1.5">
                        <input
                          className={amountCls + " border-red-200 focus:ring-red-400" + (line.debit ? " bg-red-50 border-red-300" : "")}
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          value={line.debit}
                          onChange={(e) => handleDebitChange(idx, e.target.value)}
                        />
                      </td>

                      {/* دائن */}
                      <td className="px-1.5 py-1.5">
                        <input
                          className={amountCls + " border-green-200 focus:ring-green-400" + (line.credit ? " bg-green-50 border-green-300" : "")}
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          value={line.credit}
                          onChange={(e) => handleCreditChange(idx, e.target.value)}
                        />
                      </td>

                      {/* Delete */}
                      <td className="px-1 py-1.5 text-center">
                        {lines.length > 1 && (
                          <button
                            type="button"
                            className="text-danger text-xs px-1 py-0.5 hover:bg-red-50 rounded transition-colors"
                            onClick={() => setLines((p) => p.filter((_, j) => j !== idx))}
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {/* Totals row */}
                <tr className="bg-surface border-t-2 border-border">
                  <td />
                  <td colSpan={3} className="px-3 py-2 text-end text-xs text-textSecondary font-semibold">
                    الإجمالي
                  </td>
                  <td className="px-1.5 py-2 text-end font-mono font-bold text-red-700 text-sm">
                    {totalDebit > 0 ? totalDebit.toFixed(2) : "—"}
                  </td>
                  <td className="px-1.5 py-2 text-end font-mono font-bold text-green-700 text-sm">
                    {totalCredit > 0 ? totalCredit.toFixed(2) : "—"}
                  </td>
                  <td />
                </tr>

                {/* Balance indicator */}
                {(totalDebit > 0 || totalCredit > 0) && (
                  <tr>
                    <td colSpan={7} className="px-3 py-1.5">
                      {isBalanced ? (
                        <span className="text-xs text-green-700 font-medium">✓ القيد متوازن</span>
                      ) : (
                        <span className="text-xs text-red-600 font-medium">
                          ⚠ فرق {diff.toFixed(2)} — القيد غير متوازن
                        </span>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <button
              type="button"
              onClick={() => setLines((p) => [...p, emptyLine()])}
              className="w-full py-2 text-xs text-primary hover:bg-surface border-t border-border transition-colors"
            >
              + إضافة سطر
            </button>
          </div>

          <p className="text-xs text-textSecondary">
            💡 المبلغ اختياري — إذا تُرك فارغاً يُطلب من المستخدم تعبئته عند استخدام القالب في القيد.
          </p>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={closeModal}>
              إلغاء
            </Button>
            <Button type="submit" disabled={formLoading || !formName.trim()}>
              {formLoading ? "جاري الحفظ..." : "حفظ القالب"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
