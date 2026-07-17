"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../i18n";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { ApiClientError } from "../../lib/api-client";
import {
  createRepresentative,
  updateRepresentative,
  type SalesRepresentative,
} from "../../lib/sales-representatives-client";

/**
 * The single representative create/edit form. Shared by the management list, the
 * details page and the Sales Invoice quick-create — so the same validation and
 * canonical API is always used, never duplicated.
 */
export function RepresentativeFormModal({
  rep,
  onClose,
  onSaved,
}: {
  rep: SalesRepresentative | null;
  onClose: () => void;
  onSaved: (saved: SalesRepresentative) => void;
}) {
  const t = useTranslations("salesReps");
  const locale = useLocale() as AppLocale;
  const isEdit = Boolean(rep);

  const [code, setCode] = useState(rep?.code ?? "");
  const [nameAr, setNameAr] = useState(rep?.nameAr ?? "");
  const [nameEn, setNameEn] = useState(rep?.nameEn ?? "");
  const [phone, setPhone] = useState(rep?.phone ?? "");
  const [address, setAddress] = useState(rep?.address ?? "");
  const [notes, setNotes] = useState(rep?.notes ?? "");
  const [active, setActive] = useState(rep?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return; // guard against a double submit
    if (!nameAr.trim()) { setError(t("nameAr")); return; }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        nameAr: nameAr.trim(),
        nameEn: nameEn.trim() || null,
        phone: phone.trim() || null,
        address: address.trim() || null,
        notes: notes.trim() || null,
      };
      const saved = isEdit
        ? await updateRepresentative(rep!.id, { ...payload, active })
        : await createRepresentative({ ...payload, ...(code.trim() ? { code: code.trim() } : {}) });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.localizedMessage(locale) : t("loadError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isEdit ? t("edit") : t("add")} className="max-w-lg w-[95vw]">
      <form onSubmit={submit} className="space-y-4" dir={locale === "ar" ? "rtl" : "ltr"}>
        {error && <Alert variant="error">{error}</Alert>}

        {!isEdit && (
          <div>
            <label className="block text-sm font-medium mb-1">{t("codeOptional")}</label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} placeholder="REP-0001" dir="ltr" />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1">{t("nameAr")} <span className="text-red-500">*</span></label>
          <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} required maxLength={200} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">{t("nameEn")}</label>
            <Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={200} dir="ltr" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t("phone")}</label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} dir="ltr" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">{t("address")}</label>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">{t("notes")}</label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </div>

        {isEdit && (
          <div className="flex items-center gap-2">
            <input id="repActive" type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 rounded border-border" />
            <label htmlFor="repActive" className="text-sm">{t("active")}</label>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" disabled={saving || !nameAr.trim()}>
            {saving ? t("loading") : t("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
