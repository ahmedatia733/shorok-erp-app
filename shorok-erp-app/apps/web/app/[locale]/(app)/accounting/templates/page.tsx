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

interface TemplateLineInput {
  accountId: string;
  type: "debit" | "credit";
  amount: string;
  note: string;
}

const emptyLine = (type: "debit" | "credit" = "debit"): TemplateLineInput => ({
  accountId: "",
  type,
  amount: "",
  note: "",
});

function getAllLeafAccounts(accounts: AccountRow[]): AccountRow[] {
  const result: AccountRow[] = [];
  for (const acc of accounts) {
    if (acc.isLeaf && acc.active) result.push(acc);
    if (acc.children) result.push(...getAllLeafAccounts(acc.children));
  }
  return result;
}

export default function TemplatesPage() {
  const locale = useLocale() as AppLocale;
  const isOwner = useHasRole();
  const canCreate = useHasRole("ACCOUNTANT");

  const [templates, setTemplates] = useState<JournalTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Create / Edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<JournalTemplate | null>(null);
  const [leafAccounts, setLeafAccounts] = useState<AccountRow[]>([]);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [debitLines, setDebitLines] = useState<TemplateLineInput[]>([emptyLine("debit")]);
  const [creditLines, setCreditLines] = useState<TemplateLineInput[]>([emptyLine("credit")]);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    try {
      const data = await listTemplates();
      setTemplates(data);
    } catch {
      setError("فشل تحميل قوالب القيود");
    }
  }, []);

  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  useEffect(() => {
    if (modalOpen && leafAccounts.length === 0) {
      void listAccounts().then((data) => setLeafAccounts(getAllLeafAccounts(data)));
    }
  }, [modalOpen, leafAccounts.length]);

  function openCreate() {
    setEditingTemplate(null);
    setFormName("");
    setFormDescription("");
    setDebitLines([emptyLine("debit")]);
    setCreditLines([emptyLine("credit")]);
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(template: JournalTemplate) {
    setEditingTemplate(template);
    setFormName(template.name);
    setFormDescription(template.description ?? "");
    setDebitLines(
      template.lines
        .filter((l) => l.type === "debit")
        .map((l) => ({
          accountId: l.accountId,
          type: "debit" as const,
          amount: l.amount ?? "",
          note: l.note ?? "",
        })),
    );
    setCreditLines(
      template.lines
        .filter((l) => l.type === "credit")
        .map((l) => ({
          accountId: l.accountId,
          type: "credit" as const,
          amount: l.amount ?? "",
          note: l.note ?? "",
        })),
    );
    if (
      template.lines.filter((l) => l.type === "debit").length === 0
    ) {
      setDebitLines([emptyLine("debit")]);
    }
    if (
      template.lines.filter((l) => l.type === "credit").length === 0
    ) {
      setCreditLines([emptyLine("credit")]);
    }
    setFormError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingTemplate(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormLoading(true);
    setFormError(null);

    const allLines = [
      ...debitLines
        .filter((l) => l.accountId)
        .map((l, idx) => ({
          accountId: l.accountId,
          type: "debit" as const,
          amount: l.amount || undefined,
          note: l.note || undefined,
          sortOrder: idx,
        })),
      ...creditLines
        .filter((l) => l.accountId)
        .map((l, idx) => ({
          accountId: l.accountId,
          type: "credit" as const,
          amount: l.amount || undefined,
          note: l.note || undefined,
          sortOrder: idx,
        })),
    ];

    if (allLines.length === 0) {
      setFormError("أضف سطراً واحداً على الأقل");
      setFormLoading(false);
      return;
    }

    try {
      if (editingTemplate) {
        await updateTemplate(editingTemplate.id, {
          name: formName,
          description: formDescription || undefined,
          lines: allLines,
        });
      } else {
        await createTemplate({
          name: formName,
          description: formDescription || undefined,
          lines: allLines,
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

  function updateDebitLine(idx: number, field: keyof TemplateLineInput, val: string) {
    setDebitLines((prev) => prev.map((l, i) => i === idx ? { ...l, [field]: val } : l));
  }
  function updateCreditLine(idx: number, field: keyof TemplateLineInput, val: string) {
    setCreditLines((prev) => prev.map((l, i) => i === idx ? { ...l, [field]: val } : l));
  }

  const selectCls = "w-full rounded border border-border bg-background px-2 py-1.5 text-sm";

  function SideTable({
    lines,
    onUpdate,
    onAdd,
    onRemove,
    colorCls,
    label,
  }: {
    lines: TemplateLineInput[];
    onUpdate: (idx: number, field: keyof TemplateLineInput, val: string) => void;
    onAdd: () => void;
    onRemove: (idx: number) => void;
    colorCls: string;
    label: string;
  }) {
    return (
      <div className="flex flex-col h-full">
        <div className={`py-2 text-center font-bold text-base border-b border-border ${colorCls}`}>
          {label}
        </div>
        <div className="flex-1 overflow-y-auto">
          {lines.map((line, idx) => (
            <div
              key={idx}
              className="grid grid-cols-[1fr_auto_auto] gap-1 p-2 border-b border-border last:border-0 items-center"
            >
              <select
                className={selectCls}
                value={line.accountId}
                onChange={(e) => onUpdate(idx, "accountId", e.target.value)}
              >
                <option value="">— الحساب —</option>
                {leafAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {locale === "ar" ? a.nameAr : a.nameEn}
                  </option>
                ))}
              </select>
              <input
                className="w-28 rounded border border-border bg-background px-2 py-1.5 text-sm text-end"
                type="number"
                min="0"
                step="0.01"
                placeholder="اختياري"
                value={line.amount}
                onChange={(e) => onUpdate(idx, "amount", e.target.value)}
              />
              {lines.length > 1 ? (
                <button
                  type="button"
                  className="text-danger text-sm px-1"
                  onClick={() => onRemove(idx)}
                >
                  ✕
                </button>
              ) : (
                <span className="w-5" />
              )}
            </div>
          ))}
        </div>
        <div className="border-t border-border">
          <button
            type="button"
            onClick={onAdd}
            className="w-full py-1.5 text-xs text-primary hover:bg-background transition-colors"
          >
            + إضافة سطر
          </button>
        </div>
      </div>
    );
  }

  function formatLineType(type: "debit" | "credit") {
    return type === "debit" ? "مدين" : "دائن";
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">قوالب القيود</h1>
        {canCreate && (
          <Button onClick={openCreate}>قالب جديد</Button>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="space-y-3">
        {templates.length === 0 && (
          <p className="text-textSecondary text-sm">لا توجد قوالب بعد.</p>
        )}
        {templates.map((template) => {
          const expanded = expandedIds.has(template.id);
          const confirmingDelete = deleteConfirmId === template.id;
          return (
            <Card key={template.id}>
              <CardHeader>
                <button
                  type="button"
                  className="flex items-center gap-4 text-start flex-1 min-w-0"
                  onClick={() => toggleExpand(template.id)}
                >
                  <CardTitle className="truncate">{template.name}</CardTitle>
                  {template.description && (
                    <span className="text-textSecondary text-sm truncate">{template.description}</span>
                  )}
                  <span className="text-textSecondary text-xs shrink-0">
                    {template.lines.length} سطر
                  </span>
                  <span className="text-textSecondary text-sm">{expanded ? "▾" : "▸"}</span>
                </button>
                <div className="flex items-center gap-2 shrink-0">
                  {canCreate && (
                    <Button size="sm" variant="ghost" onClick={() => openEdit(template)}>
                      تعديل
                    </Button>
                  )}
                  {isOwner && (
                    confirmingDelete ? (
                      <div className="flex items-center gap-1 text-sm">
                        <span>تأكيد الحذف؟</span>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void handleDelete(template.id)}
                        >
                          نعم
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteConfirmId(null)}
                        >
                          لا
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleteConfirmId(template.id)}
                      >
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
                        <TH>الحساب</TH>
                        <TH>النوع</TH>
                        <TH>المبلغ</TH>
                        <TH>ملاحظة</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {template.lines.map((line) => (
                        <TR key={line.id}>
                          <TD>
                            <span className="font-mono text-xs text-textSecondary me-2">
                              {line.accountCode}
                            </span>
                            {locale === "ar" ? line.accountNameAr : line.accountNameEn}
                          </TD>
                          <TD>
                            <span
                              className={
                                line.type === "debit"
                                  ? "text-red-700 font-medium"
                                  : "text-green-700 font-medium"
                              }
                            >
                              {formatLineType(line.type)}
                            </span>
                          </TD>
                          <TD>{line.amount ?? "—"}</TD>
                          <TD>{line.note ?? "—"}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </CardBody>
              )}
            </Card>
          );
        })}
      </div>

      {/* Create / Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editingTemplate ? "تعديل قالب" : "قالب جديد"}
        className="max-w-5xl w-[95vw]"
      >
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" dir="rtl">
          {formError && <Alert variant="error">{formError}</Alert>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1">اسم القالب</label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                required
                maxLength={200}
                placeholder="مثال: قيد رواتب شهري"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">الوصف (اختياري)</label>
              <Input
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                maxLength={500}
                placeholder="وصف مختصر للقالب"
              />
            </div>
          </div>

          <p className="text-xs text-textSecondary">
            المبلغ اختياري — إذا تُرك فارغاً يُطلب من المستخدم تعبئته عند استخدام القالب.
          </p>

          {/* Two-column debit / credit layout */}
          <div className="grid grid-cols-2 border border-border rounded overflow-hidden divide-x divide-border" style={{ minHeight: "240px" }}>
            {/* RIGHT: مدين */}
            <SideTable
              lines={debitLines}
              onUpdate={updateDebitLine}
              onAdd={() => setDebitLines((p) => [...p, emptyLine("debit")])}
              onRemove={(i) => setDebitLines((p) => p.filter((_, j) => j !== i))}
              colorCls="bg-red-50 text-red-700"
              label="مدين"
            />
            {/* LEFT: دائن */}
            <SideTable
              lines={creditLines}
              onUpdate={updateCreditLine}
              onAdd={() => setCreditLines((p) => [...p, emptyLine("credit")])}
              onRemove={(i) => setCreditLines((p) => p.filter((_, j) => j !== i))}
              colorCls="bg-green-50 text-green-700"
              label="دائن"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={closeModal}>
              إلغاء
            </Button>
            <Button type="submit" disabled={formLoading || !formName.trim()}>
              {formLoading ? "جاري الحفظ..." : "حفظ"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
