"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Alert } from "../../../../../components/ui/alert";
import { Input } from "../../../../../components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { getInventoryBalance, type InventoryItem } from "../../../../../lib/payments-client";
import { listBranches, type BranchSummary } from "../../../../../lib/inventory-client";

function fmt(v: string | number, dec = 2) {
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export default function StockPage() {
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [branchId, setBranchId] = useState("");
  const [rows, setRows] = useState<InventoryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listSearch, setListSearch] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const b = await listBranches();
        setBranches(b);
      } catch {
        setError("فشل تحميل الفروع");
      }
    })();
  }, []);

  useEffect(() => {
    void loadStock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  async function loadStock() {
    setLoading(true);
    setError(null);
    try {
      const data = await getInventoryBalance(branchId || undefined);
      setRows(data);
    } catch {
      setError("فشل تحميل بيانات المخزون");
    } finally {
      setLoading(false);
    }
  }

  const displayedRows = listSearch && rows
    ? rows.filter((r) =>
        (r.skuNameAr + " " + r.skuNameEn + " " + r.skuCode)
          .toLowerCase()
          .includes(listSearch.toLowerCase())
      )
    : rows;

  const grouped = displayedRows
    ? displayedRows.reduce(
        (acc, r) => {
          const key = r.branchId;
          if (!acc[key]) acc[key] = { nameAr: r.branchNameAr, items: [] };
          acc[key].items.push(r);
          return acc;
        },
        {} as Record<string, { nameAr: string; items: InventoryItem[] }>,
      )
    : {};

  const totalBoards = rows?.reduce((s, r) => s + parseFloat(r.boardsOnHand), 0) ?? 0;
  const totalMeters = rows?.reduce((s, r) => s + parseFloat(r.metersOnHand), 0) ?? 0;

  return (
    <div className="space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">جرد المخزون</h1>

      {/* Filter */}
      <div className="bg-surface border border-border rounded-lg p-4 flex items-center gap-4 flex-wrap">
        <div>
          <label className="block text-xs text-textSecondary mb-1">الفرع</label>
          <select
            className="border border-border rounded-md px-3 py-2 text-sm bg-background min-w-[200px]"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            <option value="">جميع الفروع</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.nameAr}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 mt-4">
          <Input placeholder="بحث هنا..." value={listSearch} onChange={(e) => setListSearch(e.target.value)} className="max-w-xs border-2 border-primary/40 bg-background" />
          {listSearch && <button type="button" className="text-xs text-textSecondary hover:text-text" onClick={() => setListSearch("")}>مسح ✕</button>}
        </div>
        <button
          type="button"
          onClick={() => void loadStock()}
          className="mt-4 px-4 py-2 rounded-md border border-border text-sm hover:bg-background"
        >
          تحديث
        </button>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {loading && (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
        </div>
      )}

      {rows && !loading && (
        <>
          {/* Summary totals */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-surface border border-border rounded-lg p-4 text-center">
              <div className="text-xs text-textSecondary mb-1">إجمالي الألواح</div>
              <div className="text-2xl font-bold">{fmt(totalBoards, 0)} لوح</div>
            </div>
            <div className="bg-surface border border-border rounded-lg p-4 text-center">
              <div className="text-xs text-textSecondary mb-1">إجمالي الأمتار</div>
              <div className="text-2xl font-bold">{fmt(totalMeters)} م</div>
            </div>
          </div>

          {Object.keys(grouped).length === 0 ? (
            <div className="text-center py-12 text-textSecondary">لا توجد بيانات مخزون</div>
          ) : (
            Object.entries(grouped).map(([bid, group]) => {
              const branchBoards = group.items.reduce((s, r) => s + parseFloat(r.boardsOnHand), 0);
              const branchMeters = group.items.reduce((s, r) => s + parseFloat(r.metersOnHand), 0);
              return (
                <div key={bid} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold">{group.nameAr}</h2>
                    <div className="text-sm text-textSecondary">
                      {fmt(branchBoards, 0)} لوح · {fmt(branchMeters)} م
                    </div>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <Table>
                      <THead>
                        <TR>
                          <TH>الكود</TH>
                          <TH>اسم الصنف</TH>
                          <TH>مقاس اللوح (م)</TH>
                          <TH>الألواح</TH>
                          <TH>الأمتار</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {group.items.map((r) => (
                          <TR key={r.productVariantId}>
                            <TD className="font-mono text-xs">{r.skuCode}</TD>
                            <TD>{r.skuNameAr}</TD>
                            <TD>{fmt(r.sizeMetersPerBoard)}</TD>
                            <TD className="font-medium">{fmt(r.boardsOnHand, 0)}</TD>
                            <TD className="font-medium">{fmt(r.metersOnHand)}</TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </div>
                </div>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
