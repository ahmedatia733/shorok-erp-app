"use client";

import { useCallback, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../../i18n";
import { Alert } from "../../../../components/ui/alert";
import { Button } from "../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui/card";
import { Label } from "../../../../components/ui/label";
import { BranchPicker } from "../../../../components/features/inventory/branch-picker";
import { SupplierPicker } from "../../../../components/features/factory-ledger/supplier-picker";
import {
  importDryRun,
  importCommit,
  type ImportKind,
  type ImportDryRunResult,
} from "../../../../lib/import-client";

type Step = "form" | "preview" | "done";

const KIND_OPTIONS: ImportKind[] = ["orders", "inventory", "expenses", "factory_ledger"];
const NEEDS_BRANCH: ImportKind[] = ["orders", "inventory", "expenses"];

export default function ImportPage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("import");
  const tCommon = useTranslations("common");

  const [step, setStep] = useState<Step>("form");
  const [kind, setKind] = useState<ImportKind>("orders");
  const [branchId, setBranchId] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dryRun, setDryRun] = useState<ImportDryRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const needsBranch = NEEDS_BRANCH.includes(kind);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null);
    setError(null);
  };

  const handlePreview = async () => {
    if (!file) return;
    if (needsBranch && !branchId) {
      setError(t("errors.branchRequired"));
      return;
    }
    if (!needsBranch && !supplierId) {
      setError(t("errors.supplierRequired"));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await importDryRun(
        file,
        kind,
        needsBranch ? branchId : null,
        !needsBranch ? supplierId : null,
      );
      setDryRun(result);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!dryRun) return;
    setLoading(true);
    setError(null);
    try {
      await importCommit(dryRun.sessionId);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = useCallback(() => {
    setStep("form");
    setDryRun(null);
    setFile(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const hasErrors =
    (dryRun?.validationErrors.length ?? 0) > 0 ||
    (dryRun?.missingReferences.skuCodes.length ?? 0) > 0 ||
    (dryRun?.missingReferences.variantSizes.length ?? 0) > 0;

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>

      {step === "form" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("step1Title")}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            {error && <Alert variant="error">{error}</Alert>}

            {/* Import kind */}
            <div>
              <Label htmlFor="kind">{t("kindLabel")}</Label>
              <select
                id="kind"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as ImportKind);
                  setError(null);
                }}
                className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {KIND_OPTIONS.map((k) => (
                  <option key={k} value={k}>
                    {t(`kinds.${k}`)}
                  </option>
                ))}
              </select>
            </div>

            {/* Branch or Supplier picker */}
            {needsBranch ? (
              <BranchPicker value={branchId} onChange={setBranchId} />
            ) : (
              <SupplierPicker value={supplierId} onChange={setSupplierId} />
            )}

            {/* File upload */}
            <div>
              <Label htmlFor="file">{t("fileLabel")}</Label>
              <input
                id="file"
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleFileChange}
                className="mt-1 block w-full text-sm text-textPrimary file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-primary/90 cursor-pointer"
              />
              {file && (
                <p className="mt-1 text-xs text-textSecondary">
                  {file.name} · {(file.size / 1024).toFixed(0)} KB
                </p>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={handlePreview}
                disabled={loading || !file || (needsBranch ? !branchId : !supplierId)}
              >
                {loading ? tCommon("loading") : t("previewBtn")}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {step === "preview" && dryRun && (
        <Card>
          <CardHeader>
            <CardTitle>{t("step2Title")}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            {error && <Alert variant="error">{error}</Alert>}

            {/* Summary numbers */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md border border-border bg-background p-3">
                <p className="text-textSecondary">{t("rowsParsed")}</p>
                <p className="text-lg font-semibold">{dryRun.rowsParsed}</p>
              </div>
              <div className="rounded-md border border-border bg-background p-3">
                <p className="text-textSecondary">{t("rowsValid")}</p>
                <p className="text-lg font-semibold text-success">{dryRun.rowsValid}</p>
              </div>
            </div>

            {/* Missing product codes */}
            {dryRun.missingReferences.skuCodes.length > 0 && (
              <Alert variant="error">
                <p className="font-medium mb-1">{t("missingSkus")}</p>
                <ul className="list-disc ps-4 text-xs space-y-0.5">
                  {dryRun.missingReferences.skuCodes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </Alert>
            )}

            {/* Missing variants */}
            {dryRun.missingReferences.variantSizes.length > 0 && (
              <Alert variant="error">
                <p className="font-medium mb-1">{t("missingVariants")}</p>
                <ul className="list-disc ps-4 text-xs space-y-0.5">
                  {dryRun.missingReferences.variantSizes.map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                </ul>
              </Alert>
            )}

            {/* Row-level validation errors */}
            {dryRun.validationErrors.length > 0 && (
              <div>
                <p className="text-sm font-medium text-error mb-2">
                  {t("validationErrors")} ({dryRun.validationErrors.length})
                </p>
                <div className="max-h-48 overflow-y-auto rounded-md border border-border text-xs">
                  <table className="w-full">
                    <thead className="bg-background">
                      <tr>
                        <th className="px-3 py-2 text-start">{t("errorRow")}</th>
                        <th className="px-3 py-2 text-start">{t("errorMsg")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dryRun.validationErrors.map((e, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="px-3 py-1.5 text-textSecondary">{e.row}</td>
                          <td className="px-3 py-1.5">
                            {locale === "ar" ? e.message_ar : e.message_en}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {!hasErrors && dryRun.rowsValid > 0 && (
              <Alert variant="success">{t("readyToImport")}</Alert>
            )}

            <div className="flex items-center justify-between gap-3 pt-2">
              <Button variant="ghost" onClick={handleReset} disabled={loading}>
                {tCommon("back")}
              </Button>
              <Button
                onClick={handleCommit}
                disabled={loading || hasErrors || dryRun.rowsValid === 0}
              >
                {loading ? tCommon("loading") : t("commitBtn")}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {step === "done" && (
        <Card>
          <CardBody className="space-y-4 py-8 text-center">
            <p className="text-4xl">✓</p>
            <p className="text-lg font-medium text-success">{t("successMsg")}</p>
            <p className="text-sm text-textSecondary">
              {dryRun && t("importedRows", { count: dryRun.rowsValid })}
            </p>
            <Button onClick={handleReset}>{t("importAnother")}</Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
