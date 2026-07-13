"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { getJournalEntry, type JournalEntryRow } from "../../../../../../lib/journal-client";

/** Journal-entry detail — the drilldown fallback target for statement rows whose
 *  source document has no dedicated page (receipts, expenses, manual journals,
 *  reversals). Read-only. */
export default function JournalEntryPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const [entry, setEntry] = useState<JournalEntryRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getJournalEntry(id)
      .then((e) => alive && setEntry(e))
      .catch(() => alive && setError("تعذّر تحميل القيد"))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [id]);

  if (loading) return <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>;
  if (error || !entry) return <Alert variant="error">{error ?? "القيد غير موجود"}</Alert>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">قيد يومية #{entry.entryNumber}</h1>
        <Button variant="ghost" onClick={() => router.back()}>← رجوع</Button>
      </div>
      <Card>
        <CardHeader><CardTitle>بيانات القيد</CardTitle></CardHeader>
        <CardBody>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div><span className="text-textSecondary">التاريخ:</span> {new Date(entry.entryDate).toISOString().slice(0, 10)}</div>
            <div><span className="text-textSecondary">النوع:</span> {entry.entryType}</div>
            <div><span className="text-textSecondary">المرجع:</span> {entry.reference ?? "—"}</div>
            <div><span className="text-textSecondary">الإجمالي:</span> {entry.totalDebit}</div>
          </div>
          <p className="mt-2 text-sm"><span className="text-textSecondary">البيان:</span> {entry.description}</p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>سطور القيد</CardTitle></CardHeader>
        <CardBody>
          <Table>
            <THead><TR><TH>الحساب</TH><TH>مدين</TH><TH>دائن</TH><TH>ملاحظة</TH></TR></THead>
            <TBody>
              {entry.lines.map((l) => (
                <TR key={l.id}>
                  <TD>{l.accountCode} — {l.accountNameAr}</TD>
                  <TD dir="ltr">{parseFloat(l.debit) > 0 ? l.debit : "—"}</TD>
                  <TD dir="ltr">{parseFloat(l.credit) > 0 ? l.credit : "—"}</TD>
                  <TD>{l.note ?? "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>
    </div>
  );
}
