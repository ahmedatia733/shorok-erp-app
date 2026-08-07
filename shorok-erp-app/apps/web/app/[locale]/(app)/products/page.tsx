"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../../i18n";
import { Alert } from "../../../../components/ui/alert";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui/card";
import { EmptyState } from "../../../../components/ui/empty-state";
import { Input } from "../../../../components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { ProductCreateModal } from "../../../../components/features/products/product-create-modal";
import { useHasRole } from "../../../../lib/auth";
import { formatCurrency, formatDate } from "../../../../lib/format";
import { listProductCatalogue, type ProductCatalogueRow } from "../../../../lib/admin-client";

/**
 * إدارة الأصناف — the base-product catalogue.
 *
 * One row per product, never one per size. A product sold in ك, ص and a couple
 * of custom boards is still one product here; its sizes belong to the purchase
 * and stock screens, where they actually mean something.
 */
export default function ProductsPage() {
  const locale = useLocale() as AppLocale;
  const canCreate = useHasRole("OWNER");
  const [rows, setRows] = useState<ProductCatalogueRow[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listProductCatalogue(search);
      setRows(res.products);
    } catch (e) {
      setError((e as Error).message || "تعذّر تحميل الأصناف.");
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">إدارة الأصناف</h1>
        {canCreate && (
          <Button variant="success" data-testid="add-product" onClick={() => setModalOpen(true)}>
            + إضافة صنف جديد
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>الأصناف</CardTitle>
          <Input
            aria-label="بحث"
            data-testid="product-search"
            placeholder="ابحث بالكود أو الاسم"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64"
          />
        </CardHeader>
        <CardBody>
          {error && <Alert variant="error">{error}</Alert>}
          {loading ? (
            <p className="text-sm text-textSecondary">جارٍ تحميل الأصناف...</p>
          ) : rows.length === 0 ? (
            <EmptyState title="لا توجد أصناف" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>كود الصنف</TH>
                  <TH>اسم الصنف</TH>
                  <TH>سعر الشراء</TH>
                  <TH>الحالة</TH>
                  <TH>تاريخ الإضافة</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((p) => (
                  <TR key={p.id} data-testid={`product-row-${p.code}`}>
                    <TD className="font-mono">{p.code}</TD>
                    <TD>{p.nameAr}</TD>
                    <TD>
                      {p.purchasePrice ? (
                        <span
                          title={
                            p.purchasePriceSource === "LAST_CONFIRMED_PURCHASE"
                              ? "آخر سعر شراء مؤكد"
                              : "السعر المبدئي قبل أول عملية شراء"
                          }
                        >
                          {formatCurrency(p.purchasePrice, locale)}
                        </span>
                      ) : (
                        // Nothing has been bought and nothing was typed — say so
                        // rather than print a zero that looks like a decision.
                        <span className="text-textSecondary">—</span>
                      )}
                    </TD>
                    <TD>
                      <Badge variant={p.active ? "success" : "neutral"}>
                        {p.active ? "نشط" : "غير نشط"}
                      </Badge>
                    </TD>
                    <TD className="text-textSecondary">{formatDate(p.createdAt, locale)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-textSecondary">
            سعر الشراء المعروض هو آخر سعر شراء مؤكد، أو السعر المبدئي قبل أول عملية شراء.
            المقاسات تُحدَّد من خلال فواتير الشراء.
          </p>
        </CardBody>
      </Card>

      <ProductCreateModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => {
          // Refetch rather than splice the row in: the price column is derived
          // server-side, so the server's answer is the one worth showing.
          void load();
        }}
      />
    </div>
  );
}
