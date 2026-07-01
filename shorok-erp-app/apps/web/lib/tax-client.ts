import { apiCall } from "./api-client";
import { listAccounts, type AccountRow } from "./accounts-client";

export interface TaxAccount {
  id: string;
  code: string;
  nameAr: string;
}

export { listAccounts, type AccountRow };

export interface TaxInvoiceDetail {
  type: "sales" | "purchase";
  invoiceNumber: string;
  invoiceDate: string;
  entityLabel: string;
  entityNameAr: string | null;
  entityCode: string | null;
  branchNameAr: string | null;
  subtotal: string;
  taxRate: string | null;
  taxAmount: string;
  grandTotal: string;
  totalCost: string | null;
  notes: string | null;
}

export interface TaxEntry {
  id: string;
  entryId: string;
  entryNumber: string;
  date: string;
  reference: string;
  referenceType: string;
  referenceLabel: string;
  referenceId: string | null;
  description: string;
  note: string;
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  debit: string;
  credit: string;
  runningBalance: string;
  invoiceDetail: TaxInvoiceDetail | null;
}

export interface TaxBalance {
  debit: string;
  credit: string;
  net: string;
}

export interface TaxLedgerResult {
  from: string | null;
  to: string | null;
  accounts: TaxAccount[];
  opening: TaxBalance;
  entries: TaxEntry[];
  periodTotals: TaxBalance;
  closing: TaxBalance & { status: "liability" | "receivable" | "zero" };
}

export async function listTaxAccounts(): Promise<TaxAccount[]> {
  return apiCall<TaxAccount[]>("/reports/tax-accounts");
}

export async function getTaxLedger(params: {
  accountId?: string;
  from?: string;
  to?: string;
}): Promise<TaxLedgerResult> {
  const q = new URLSearchParams();
  if (params.accountId) q.set("accountId", params.accountId);
  if (params.from)      q.set("from", params.from);
  if (params.to)        q.set("to", params.to);
  return apiCall<TaxLedgerResult>(`/reports/tax-ledger?${q.toString()}`);
}
