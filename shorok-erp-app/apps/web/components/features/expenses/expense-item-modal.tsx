"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Alert } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Modal } from "../../ui/modal";
import { ApiClientError } from "../../../lib/api-client";
import { createExpenseAccount, updateExpenseAccount } from "../../../lib/expense-accounts-client";
import { suggestExpenseCode } from "../../../lib/expense-code";

/**
 * Adding an expense item — the one form, wherever it is opened from.
 *
 * The expenses page and the journal-entry quick-add both mount this component,
 * so there is a single set of rules and a single endpoint behind both. What it
 * creates is a real Chart-of-Accounts account; the category and account type are
 * filled in by the server, because they are how the system records "this is an
 * expense" and are not a question worth asking someone who wants to add
 * «الكهرباء».
 */

interface CreateProps {
  open: boolean;
  onClose: () => void;
  /** Receives the created account so a caller can select it immediately. */
  onCreated: (account: { id: string; code: string; nameAr: string }) => void;
  /** Codes already in use, to suggest a free one and warn before submitting. */
  existingCodes?: string[];
}

export function ExpenseItemCreateModal({ open, onClose, onCreated, existingCodes = [] }: CreateProps) {
  const [nameAr, setNameAr] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh form every time it opens, with a suggested code that reflects the
  // chart as it stands right now.
  useEffect(() => {
    if (!open) return;
    setNameAr("");
    setCode(suggestExpenseCode(existingCodes));
    setError(null);
    setSubmitting(false);
    // `existingCodes` is intentionally not a dependency: re-suggesting mid-typing
    // would overwrite a code the user has already edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const duplicate = code.trim() !== "" && existingCodes.includes(code.trim());
  const canSubmit = nameAr.trim() !== "" && code.trim() !== "" && !duplicate && !submitting;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createExpenseAccount({ nameAr: nameAr.trim(), code: code.trim() });
      onCreated(created);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.localizedMessage("ar")
          : "تعذّر إضافة بند المصروف.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="إضافة بند مصروف جديد">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert variant="error">{error}</Alert>}

        <div>
          <Label htmlFor="expense-name">اسم بند المصروف</Label>
          <Input
            id="expense-name"
            data-testid="expense-name"
            autoFocus
            value={nameAr}
            maxLength={160}
            onChange={(e) => setNameAr(e.target.value)}
            disabled={submitting}
            placeholder="مثال: الكهرباء والمرافق"
          />
        </div>

        <div>
          <Label htmlFor="expense-code">كود الحساب</Label>
          <Input
            id="expense-code"
            data-testid="expense-code"
            dir="ltr"
            value={code}
            maxLength={20}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
            disabled={submitting}
          />
          {duplicate ? (
            <p className="mt-1 text-xs text-danger" data-testid="expense-code-duplicate">
              هذا الكود مستخدم بالفعل في دليل الحسابات.
            </p>
          ) : (
            <p className="mt-1 text-xs text-textSecondary">
              كود مقترح من تسلسل حسابات المصروفات، ويمكن تعديله. لا يجوز تكراره في دليل الحسابات.
            </p>
          )}
        </div>

        <p className="rounded-md border border-border bg-background p-2 text-xs text-textSecondary">
          يُنشأ البند كحساب مصروفات حقيقي في دليل الحسابات، ويظهر مباشرة في القيود والتقارير.
          إضافة البند لا تُنشئ أي قيد محاسبي.
        </p>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            إلغاء
          </Button>
          <Button type="submit" variant="success" data-testid="expense-create-submit" disabled={!canSubmit}>
            {submitting ? "جارٍ الحفظ…" : "إضافة البند"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface EditProps {
  item: { accountId: string; code: string; nameAr: string; active: boolean } | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Editing an expense item.
 *
 * The code is shown but never editable: it is quoted on posted journals and
 * printed on reports, so changing it would rewrite how history reads. Retiring
 * an item is a deactivation, never a delete — the account stays in every
 * historical journal and report and only stops being offered for new entries.
 */
export function ExpenseItemEditModal({ item, onClose, onSaved }: EditProps) {
  const [nameAr, setNameAr] = useState("");
  const [active, setActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setNameAr(item.nameAr);
    setActive(item.active);
    setError(null);
    setSubmitting(false);
  }, [item]);

  if (!item) return null;

  const changed = nameAr.trim() !== item.nameAr || active !== item.active;
  const canSubmit = nameAr.trim() !== "" && changed && !submitting;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await updateExpenseAccount(item.accountId, {
        ...(nameAr.trim() !== item.nameAr ? { nameAr: nameAr.trim() } : {}),
        ...(active !== item.active ? { active } : {}),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.localizedMessage("ar") : "تعذّر حفظ التعديل.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={Boolean(item)} onClose={onClose} title={`تعديل بند: ${item.nameAr}`}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert variant="error">{error}</Alert>}

        <div>
          <Label htmlFor="edit-expense-code">كود الحساب</Label>
          <Input id="edit-expense-code" dir="ltr" value={item.code} disabled readOnly />
          <p className="mt-1 text-xs text-textSecondary">
            الكود ثابت لأنه مذكور في القيود والتقارير السابقة.
          </p>
        </div>

        <div>
          <Label htmlFor="edit-expense-name">اسم بند المصروف</Label>
          <Input
            id="edit-expense-name"
            data-testid="expense-edit-name"
            value={nameAr}
            maxLength={160}
            onChange={(e) => setNameAr(e.target.value)}
            disabled={submitting}
          />
        </div>

        <div className="rounded-md border border-border p-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="expense-edit-active"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              disabled={submitting}
              className="mt-1"
            />
            <span>
              <span className="font-medium">بند نشط</span>
              <span className="mt-1 block text-xs text-textSecondary">
                إلغاء التفعيل يوقف اختيار البند في القيود الجديدة فقط. يظل ظاهراً في كل القيود
                والتقارير السابقة، ولا يُحذف رصيده ولا تاريخه.
              </span>
            </span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            إلغاء
          </Button>
          <Button type="submit" data-testid="expense-edit-submit" disabled={!canSubmit}>
            {submitting ? "جارٍ الحفظ…" : "حفظ التعديل"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
