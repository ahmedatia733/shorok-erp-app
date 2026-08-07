"use client";

import { useEffect, useState } from "react";
import { ApiClientError } from "../../../lib/api-client";
import { updateProduct, type ProductCatalogueRow } from "../../../lib/admin-client";
import { Alert } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Modal } from "../../ui/modal";

interface Props {
  product: ProductCatalogueRow | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Editing a product's code, name and default purchase price.
 *
 * The price needs care. A product whose sizes were bought at different prices
 * has no single default, so the field is left empty and labelled rather than
 * pre-filled with one of them — pre-filling would quietly propose unifying the
 * others. And a price is only ever sent when the user actually changed it:
 * "untouched" must mean "leave every size alone", never "set them all to
 * whatever is in the box".
 */
export function ProductEditModal({ product, onClose, onSaved }: Props) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnify, setConfirmUnify] = useState(false);

  const multiple = product?.purchasePriceState === "MULTIPLE";
  // What the field started as, so "did the user change it?" is a real question
  // and not a guess.
  const originalPrice = multiple ? "" : (product?.defaultPurchasePrice ?? "");

  useEffect(() => {
    if (product) {
      setCode(product.code);
      setName(product.nameAr);
      setPrice(multiple ? "" : (product.defaultPurchasePrice ?? ""));
      setError(null);
      setBusy(false);
      setConfirmUnify(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);

  if (!product) return null;

  const priceTouched = price.trim() !== originalPrice.trim();
  const priceValid = price.trim() === "" || /^\d+(\.\d{1,2})?$/.test(price.trim()) && Number(price) > 0;
  const wantsPriceChange = priceTouched && price.trim() !== "";
  const needsConfirm = wantsPriceChange && multiple && !confirmUnify;
  const canSave =
    code.trim() !== "" && name.trim() !== "" && priceValid && !needsConfirm && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await updateProduct(product.id, {
        code: code.trim(),
        colorNameAr: name.trim(),
        // Only when genuinely changed — an untouched field sends nothing.
        ...(wantsPriceChange ? { purchasePriceUpdate: { apply: true as const, value: price.trim() } } : {}),
      });
      onSaved();
      onClose();
    } catch (e) {
      const d = e instanceof ApiClientError
        ? (e.payload?.details as { messageAr?: string; reason?: string } | undefined)
        : undefined;
      setError(
        d?.messageAr ??
          (d?.reason === "PRODUCT_CODE_ALREADY_EXISTS"
            ? "كود الصنف مستخدم بالفعل."
            : "تعذّر حفظ التعديلات. لم يتم تغيير أي بيانات."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={product !== null} onClose={onClose} title="تعديل الصنف">
      <div className="space-y-3">
        {error && <Alert variant="error">{error}</Alert>}

        <div>
          <Label htmlFor="ep-code">كود الصنف</Label>
          <Input id="ep-code" data-testid="edit-product-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>

        <div>
          <Label htmlFor="ep-name">اسم الصنف</Label>
          <Input id="ep-name" data-testid="edit-product-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <Label htmlFor="ep-price">سعر الشراء الافتراضي</Label>
          <Input
            id="ep-price"
            data-testid="edit-product-price"
            inputMode="decimal"
            dir="ltr"
            placeholder={multiple ? "أسعار متعددة حسب المقاس" : ""}
            value={price}
            onChange={(e) => {
              setPrice(e.target.value.replace(/[^\d.]/g, ""));
              setConfirmUnify(false);
            }}
          />
          {multiple && !wantsPriceChange && (
            <p className="mt-1 text-xs text-textSecondary" data-testid="edit-multiple-note">
              أسعار شراء مختلفة حسب المقاس. اتركه فارغًا لعدم تغيير الأسعار.
            </p>
          )}
          {price.trim() !== "" && !priceValid && (
            <p className="mt-1 text-xs text-danger">أدخل سعر شراء صحيح أكبر من صفر.</p>
          )}
          {!multiple && (
            <p className="mt-1 text-xs text-textSecondary">
              يُستخدم للمشتريات الجديدة فقط. لا يغيّر المخزون ولا متوسط التكلفة ولا الفواتير السابقة.
            </p>
          )}
        </div>

        {needsConfirm && (
          <Alert variant="warning">
            <p data-testid="edit-unify-warning">
              هذا الصنف لديه أسعار شراء افتراضية مختلفة حسب المقاس. سيتم توحيد سعر الشراء
              الافتراضي للمقاسات المستخدمة في المشتريات الجديدة إلى {price.trim()}. لن يتم
              تغيير المخزون أو متوسط التكلفة أو الفواتير القديمة.
            </p>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="edit-unify-confirm"
                checked={confirmUnify}
                onChange={(e) => setConfirmUnify(e.target.checked)}
              />
              أوافق على توحيد سعر الشراء الافتراضي
            </label>
          </Alert>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button data-testid="edit-product-submit" onClick={save} disabled={!canSave}>
            {busy ? "جارٍ الحفظ..." : "حفظ التعديلات"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
