"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Input } from "../../../../../../components/ui/input";
import { Label } from "../../../../../../components/ui/label";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { SourceSizeOptions } from "../../../../../../components/features/inventory/source-size-options";
import { TransferPreviewPanel } from "../../../../../../components/features/inventory/transfer-preview-panel";
import { SearchableSelect } from "../../../../../../components/ui/searchable-select";
import { ApiClientError } from "../../../../../../lib/api-client";
import { listBranches, type BranchSummary } from "../../../../../../lib/inventory-client";
import {
  createTransfer,
  getSourceProducts,
  previewTransferPayload,
  type InventoryTransferPreview,
  type SourceProduct,
  type SourceSizeOption,
  type TransferPayload,
} from "../../../../../../lib/inventory-transfers-client";

interface DraftLine {
  key: string;
  /** Step 1 — the base product. Branch-independent. */
  productSkuId: string | null;
  /** Step 2 — the exact variant, chosen from what the source branch really holds. */
  productVariantId: string | null;
  /** The chosen card, kept so the line can show its board size read-only. */
  sizeOption: SourceSizeOption | null;
  /** Kept as typed text so a stray decimal point is rejected, not rounded. */
  boardQuantity: string;
}

const newLine = (): DraftLine => ({
  key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  productSkuId: null,
  productVariantId: null,
  sizeOption: null,
  boardQuantity: "",
});

function apiMessages(e: unknown): string[] {
  if (e instanceof ApiClientError) {
    const details = e.payload?.details as { messages?: string[] } | undefined;
    if (details?.messages?.length) return details.messages;
  }
  return [(e as Error).message];
}

export default function NewInventoryTransferPage() {
  const locale = useLocale() as AppLocale;
  const router = useRouter();

  const [branches, setBranches] = useState<BranchSummary[]>([]);
  // Only the products that can actually leave the chosen source warehouse.
  const [products, setProducts] = useState<SourceProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  /** Discards a slow answer for a branch the user has already moved on from. */
  const productsTicket = useRef(0);
  const [transferDate, setTransferDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sourceBranchId, setSourceBranchId] = useState("");
  const [destinationBranchId, setDestinationBranchId] = useState("");
  const [purpose, setPurpose] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);

  const [preview, setPreview] = useState<InventoryTransferPreview | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listBranches().then((rows) => setBranches(rows.filter((b) => b.active)));
  }, []);

  // The catalogue is no longer the product list — the source warehouse is.
  useEffect(() => {
    if (!sourceBranchId) {
      setProducts([]);
      setProductsError(null);
      setProductsLoading(false);
      return;
    }
    const ticket = ++productsTicket.current;
    const asked = sourceBranchId;
    setProductsLoading(true);
    setProductsError(null);
    void getSourceProducts(asked)
      .then((res) => {
        // Two guards, because an out-of-order response must never repaint the
        // picker with another warehouse's products: the newest request wins,
        // and the payload has to say it is about the branch we are showing.
        if (ticket !== productsTicket.current || res.sourceBranchId !== asked) return;
        setProducts(res.products);
      })
      .catch((e: unknown) => {
        if (ticket !== productsTicket.current) return;
        setProducts([]);
        setProductsError(apiMessages(e)[0] ?? "تعذّر تحميل الأصناف المتاحة.");
      })
      .finally(() => {
        if (ticket === productsTicket.current) setProductsLoading(false);
      });
  }, [sourceBranchId]);

  /**
   * Changing the source warehouse invalidates the whole line, product included.
   *
   * P10 kept the product across a branch change on the reasoning that a product
   * is the same product wherever it sits. That is true of the product but not
   * of the choice: the picker now only offers what the selected warehouse can
   * actually send, so a product carried over from the previous branch may not
   * be transferable here at all. Clearing it is the honest behaviour.
   */
  const changeSourceBranch = (branchId: string) => {
    setSourceBranchId(branchId);
    setLines((ls) =>
      ls.map((l) => ({ ...l, productSkuId: null, productVariantId: null, sizeOption: null, boardQuantity: "" })),
    );
    setPreview(null);
  };

  /** A different product means different sizes; the old selection cannot stand. */
  const changeLineSku = (index: number, skuId: string) => {
    setLines((ls) =>
      ls.map((l, i) =>
        i === index
          ? { ...l, productSkuId: skuId || null, productVariantId: null, sizeOption: null, boardQuantity: "" }
          : l,
      ),
    );
    setPreview(null);
  };

  /** A different size means the quantity was typed against the wrong board. */
  const changeLineSize = (index: number, variantId: string | null, option: SourceSizeOption | null) => {
    setLines((ls) =>
      ls.map((l, i) =>
        i === index ? { ...l, productVariantId: variantId, sizeOption: option, boardQuantity: "" } : l,
      ),
    );
    setPreview(null);
  };

  const payload = useMemo<TransferPayload | null>(() => {
    const ready = lines.filter((l) => l.productVariantId && l.boardQuantity.trim() !== "");
    if (!sourceBranchId || !destinationBranchId || ready.length === 0) return null;
    return {
      transferDate,
      sourceBranchId,
      destinationBranchId,
      purpose: purpose.trim() || null,
      notes: notes.trim() || null,
      lines: ready.map((l) => ({
        productVariantId: l.productVariantId!,
        boardQuantity: l.boardQuantity.trim(),
      })),
    };
  }, [lines, sourceBranchId, destinationBranchId, transferDate, purpose, notes]);

  const sameBranch = Boolean(sourceBranchId && sourceBranchId === destinationBranchId);

  // Any edit invalidates a shown preview: an approval must never survive the
  // numbers it was based on.
  useEffect(() => {
    setPreview(null);
  }, [payload]);

  const runPreview = async () => {
    if (!payload) return;
    setBusy(true);
    setErrors([]);
    try {
      setPreview(await previewTransferPayload(payload));
    } catch (e) {
      setErrors(apiMessages(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!payload) return;
    setBusy(true);
    setErrors([]);
    try {
      const created = await createTransfer(payload);
      router.push(`/${locale}/inventory/transfers/${created.id}`);
    } catch (e) {
      setErrors(apiMessages(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">إذن تحويل مخزون جديد</h1>

      <Alert variant="info">
        أدخل عدد الألواح الكاملة فقط. النظام يحسب الأمتار تلقائيًا من مقاس اللوح المسجَّل على الصنف،
        ولا يمكن إدخال الأمتار يدويًا.
      </Alert>

      {errors.length > 0 && (
        <Alert variant="error">
          <ul className="list-disc space-y-1 pe-5">
            {errors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>بيانات الإذن</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="transfer-date">تاريخ التحويل</Label>
            <Input
              id="transfer-date"
              type="date"
              value={transferDate}
              onChange={(e) => setTransferDate(e.target.value)}
            />
          </div>
          <div />
          <div>
            <Label htmlFor="source-branch">من مخزن</Label>
            <select
              id="source-branch"
              value={sourceBranchId}
              onChange={(e) => changeSourceBranch(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
            >
              <option value="">— اختر المخزن المصدر —</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.nameAr}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="destination-branch">إلى مخزن</Label>
            <select
              id="destination-branch"
              value={destinationBranchId}
              onChange={(e) => setDestinationBranchId(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
            >
              <option value="">— اختر المخزن المستلم —</option>
              {branches
                // Removed rather than merely rejected: an option that can only
                // produce an error is not worth offering.
                .filter((b) => b.id !== sourceBranchId)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.nameAr}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <Label htmlFor="purpose">الغرض</Label>
            <Input id="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="notes">ملاحظات</Label>
            <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </CardBody>
      </Card>

      {sameBranch && <Alert variant="error">لا يمكن اختيار نفس المخزن كمصدر ومستلم.</Alert>}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>البنود</CardTitle>
          <Button variant="secondary" onClick={() => setLines((ls) => [...ls, newLine()])}>
            إضافة بند
          </Button>
        </CardHeader>
        <CardBody>
          <Table>
            <THead>
              <TR>
                <TH className="w-1/3">اختر الصنف</TH>
                <TH className="w-1/3">اختر المقاس المتاح في المخزن المصدر</TH>
                <TH>عدد الألواح</TH>
                <TH>مقاس اللوح</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {lines.map((line, index) => (
                <TR key={line.key}>
                  <TD>
                    {!sourceBranchId ? (
                      <p className="text-sm text-textSecondary">اختر المخزن المصدر أولًا.</p>
                    ) : productsError ? (
                      <p className="text-sm text-danger" data-testid={`line-sku-error-${index}`}>
                        {productsError}
                      </p>
                    ) : !productsLoading && products.length === 0 ? (
                      <p className="text-sm text-textSecondary" data-testid={`line-sku-empty-${index}`}>
                        لا توجد أصناف متاحة للتحويل في المخزن المحدد.
                      </p>
                    ) : (
                      <SearchableSelect
                        id={`line-sku-${index}`}
                        testId={`line-sku-${index}`}
                        value={line.productSkuId ?? ""}
                        onChange={(id) => changeLineSku(index, id)}
                        placeholder="— اختر الصنف —"
                        loading={productsLoading}
                        loadingText="جارٍ تحميل الأصناف المتاحة..."
                        emptyText="لا توجد أصناف متاحة للتحويل في المخزن المحدد."
                        clearable
                        // Search still matches code, Arabic and English name —
                        // but only within what this warehouse can actually send.
                        options={products.map((pr) => ({
                          value: pr.productSkuId,
                          label: `${pr.code} — ${pr.nameAr}`,
                          keywords: [pr.code, pr.nameAr, pr.nameEn].filter(Boolean).join(" "),
                        }))}
                      />
                    )}
                  </TD>
                  <TD>
                    <SourceSizeOptions
                      sourceBranchId={sourceBranchId || null}
                      productSkuId={line.productSkuId}
                      value={line.productVariantId}
                      onChange={(variantId, option) => changeLineSize(index, variantId, option)}
                      locale={locale}
                    />
                  </TD>
                  <TD>
                    <Input
                      aria-label={`عدد الألواح للبند ${index + 1}`}
                      inputMode="numeric"
                      // A quantity is meaningless until a size is chosen: the
                      // number of boards only means something once we know
                      // which board.
                      disabled={!line.productVariantId}
                      value={line.boardQuantity}
                      onChange={(e) =>
                        setLines((ls) =>
                          ls.map((l, i) =>
                            // Digits only, at the keystroke: whole boards are the
                            // only thing this document can carry.
                            i === index ? { ...l, boardQuantity: e.target.value.replace(/[^\d]/g, "") } : l,
                          ),
                        )
                      }
                      className="w-24"
                    />
                  </TD>
                  <TD>
                    {/* Read-only, straight from the chosen variant — never typed. */}
                    <span className="text-sm text-textSecondary" data-testid={`line-board-size-${index}`}>
                      {line.sizeOption ? line.sizeOption.dimensionsLabelAr : "—"}
                    </span>
                  </TD>
                  <TD>
                    {lines.length > 1 && (
                      <Button
                        variant="ghost"
                        onClick={() => setLines((ls) => ls.filter((_, i) => i !== index))}
                      >
                        حذف
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      <div className="flex gap-2">
        <Button variant="secondary" onClick={runPreview} disabled={!payload || busy || sameBranch}>
          احتساب المعاينة
        </Button>
        <Button onClick={saveDraft} disabled={!payload || busy || sameBranch}>
          حفظ كمسودة
        </Button>
      </div>

      {preview && <TransferPreviewPanel preview={preview} locale={locale} />}
    </div>
  );
}
