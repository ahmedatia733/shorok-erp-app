"use client";

import { useEffect, useState } from "react";
import { ApiClientError } from "../../../lib/api-client";
import { createProduct, type SkuRow } from "../../../lib/admin-client";
import { Alert } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Modal } from "../../ui/modal";

export interface CreatedProduct extends SkuRow {
  firstVariant?: { id: string; sizeMetersPerBoard: string };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (product: CreatedProduct, enteredPrice: string) => void;
  /**
   * Ask for the product's first board size.
   *
   * False on the catalogue page: that screen manages BASE products, and a size
   * has no meaning until someone buys one. True in the purchase invoice, where
   * a line has nothing to post against until an exact size exists — so the user
   * states one rather than the system inventing a default.
   */
  withSize?: boolean;
}

/**
 * The one add-product form.
 *
 * The catalogue page and the purchase invoice both open this and both submit
 * through the same endpoint, so the two can never drift into different rules
 * about what a valid product is.
 */
export function ProductCreateModal({ open, onClose, onCreated, withSize = false }: Props) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every opening starts clean — a code left over from a previous attempt is
  // exactly the sort of thing that creates a product nobody meant to create.
  useEffect(() => {
    if (open) {
      setCode("");
      setName("");
      setPrice("");
      setSize("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const priceValid = /^\d+(\.\d{1,2})?$/.test(price.trim()) && Number(price) > 0;
  const sizeValid = !withSize || (/^\d+(\.\d{1,4})?$/.test(size.trim()) && Number(size) > 0);
  const canSubmit = code.trim() !== "" && name.trim() !== "" && priceValid && sizeValid && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createProduct({
        code: code.trim(),
        colorNameAr: name.trim(),
        initialPurchasePricePerMeter: price.trim(),
        ...(withSize ? { firstVariant: { sizeMetersPerBoard: size.trim() } } : {}),
      });
      // The caller receives the price the user typed, so a purchase line can be
      // prefilled with it without re-reading anything.
      onCreated(created, price.trim());
      onClose();
    } catch (e) {
      const details = e instanceof ApiClientError
        ? (e.payload?.details as { messageAr?: string; reason?: string } | undefined)
        : undefined;
      setError(
        details?.messageAr ??
          (details?.reason === "PRODUCT_CODE_ALREADY_EXISTS"
            ? "كود الصنف مستخدم بالفعل."
            : "تعذّر إضافة الصنف. لم يتم حفظ أي بيانات."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="إضافة صنف جديد">
      <div className="space-y-3">
        {error && <Alert variant="error">{error}</Alert>}

        <div>
          <Label htmlFor="np-code">كود الصنف</Label>
          <Input
            id="np-code"
            data-testid="new-product-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
          {code !== "" && code.trim() === "" && (
            <p className="mt-1 text-xs text-danger">أدخل كود الصنف.</p>
          )}
        </div>

        <div>
          <Label htmlFor="np-name">اسم الصنف</Label>
          <Input
            id="np-name"
            data-testid="new-product-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {name !== "" && name.trim() === "" && (
            <p className="mt-1 text-xs text-danger">أدخل اسم الصنف.</p>
          )}
        </div>

        <div>
          <Label htmlFor="np-price">سعر الشراء</Label>
          <Input
            id="np-price"
            data-testid="new-product-price"
            inputMode="decimal"
            dir="ltr"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))}
          />
          {price !== "" && !priceValid && (
            <p className="mt-1 text-xs text-danger">أدخل سعر شراء صحيح أكبر من صفر.</p>
          )}
        </div>

        {withSize && (
          <div>
            <Label htmlFor="np-size">مقاس اللوح (م)</Label>
            <Input
              id="np-size"
              data-testid="new-product-size"
              inputMode="decimal"
              dir="ltr"
              value={size}
              onChange={(e) => setSize(e.target.value.replace(/[^\d.]/g, ""))}
            />
            <p className="mt-1 text-xs text-textSecondary">
              مطلوب هنا فقط لأن بند الفاتورة يحتاج مقاسًا محددًا. يمكن إضافة مقاسات أخرى لاحقًا.
            </p>
            {size !== "" && !sizeValid && (
              <p className="mt-1 text-xs text-danger">أدخل مقاس لوح صحيح أكبر من صفر.</p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button data-testid="new-product-submit" onClick={submit} disabled={!canSubmit}>
            {busy ? "جارٍ الحفظ..." : "حفظ"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
