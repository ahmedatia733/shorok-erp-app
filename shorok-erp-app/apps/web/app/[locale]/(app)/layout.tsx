"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../i18n";
import { LanguageSwitcher } from "../../../components/layout/language-switcher";
import { Button } from "../../../components/ui/button";
import { useAuth } from "../../../lib/auth";

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <span
      className="transition-transform duration-200 inline-block text-textSecondary"
      style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
    >
      ▾
    </span>
  );
}

function NavSection({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-md px-3 py-2 text-xs font-semibold uppercase tracking-wider text-textSecondary hover:bg-background"
      >
        <span>{label}</span>
        <ChevronIcon open={open} />
      </button>
      {open && <div className="ms-2 space-y-0.5">{children}</div>}
    </div>
  );
}

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className="block rounded-md px-3 py-2 text-sm hover:bg-background">
      {label}
    </a>
  );
}

export default function ProtectedAppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const locale = useLocale() as AppLocale;
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const { user, isLoading, logout } = useAuth();

  const [accountingOpen, setAccountingOpen] = useState(true);
  const [purchasingOpen, setPurchasingOpen] = useState(true);
  const [salesOpen, setSalesOpen] = useState(true);
  const [warehousesOpen, setWarehousesOpen] = useState(true);
  const [reportsOpen, setReportsOpen] = useState(true);

  useEffect(() => {
    if (!isLoading && !user) router.replace(`/${locale}/login`);
  }, [isLoading, user, locale, router]);

  if (isLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-textSecondary">
        {tCommon("loading")}
      </div>
    );
  }

  const isOwner = user.role === "OWNER";
  const canSeeAccounting = isOwner || user.role === "ACCOUNTANT";

  return (
    <div className="min-h-screen flex">
      <aside className="w-64 border-e border-border bg-surface p-4 overflow-y-auto">
        <div className="mb-6 text-lg font-bold">شروق · Shorok</div>
        <nav className="space-y-1 text-sm">

          {/* Accounting section — OWNER and ACCOUNTANT only */}
          {canSeeAccounting && (
            <NavSection
              label={t("accountingSection")}
              open={accountingOpen}
              onToggle={() => setAccountingOpen((v) => !v)}
            >
              <NavLink href={`/${locale}/accounting/accounts`} label={t("chartOfAccounts")} />
              <NavLink href={`/${locale}/accounting/journal`} label={t("journalEntries")} />
              <NavLink href={`/${locale}/accounting/templates`} label="قوالب القيود" />
              <NavLink href={`/${locale}/accounting/income-statement`} label={t("incomeStatement")} />
              <NavLink href={`/${locale}/accounting/statement`} label="كشف الحساب" />
              <NavLink href={`/${locale}/accounting/customers`} label="كشف حساب عميل" />
              <NavLink href={`/${locale}/accounting/fixed-assets`} label="الأصول الثابتة" />
              <NavLink href={`/${locale}/accounting/reports/trial-balance`} label="ميزان المراجعة" />
              <NavLink href={`/${locale}/accounting/reports/balance-sheet`} label="الميزانية العمومية" />
              <NavLink href={`/${locale}/accounting/reports/aging`} label="عمر الديون" />
            </NavSection>
          )}

          {/* Purchasing section */}
          <NavSection
            label={t("purchasingSection")}
            open={purchasingOpen}
            onToggle={() => setPurchasingOpen((v) => !v)}
          >
            <NavLink href={`/${locale}/purchasing/invoices`} label={t("purchaseInvoices")} />
            <NavLink href={`/${locale}/suppliers`} label={t("suppliers")} />
            <NavLink href={`/${locale}/factory-orders`} label={t("factoryOrders")} />
          </NavSection>

          {/* Sales section */}
          <NavSection
            label={t("salesSection")}
            open={salesOpen}
            onToggle={() => setSalesOpen((v) => !v)}
          >
            <NavLink href={`/${locale}/orders`} label={t("orders")} />
            <NavLink href={`/${locale}/sales/invoices`} label="فواتير المبيعات" />
          </NavSection>

          {/* Warehouses section */}
          <NavSection
            label={t("warehousesSection")}
            open={warehousesOpen}
            onToggle={() => setWarehousesOpen((v) => !v)}
          >
            <NavLink href={`/${locale}/inventory`} label={t("inventory")} />
            <NavLink href={`/${locale}/inventory/movements`} label={t("inventoryMovements")} />
            <NavLink href={`/${locale}/inventory/stock`} label="جرد المخزون" />
          </NavSection>

          {/* Reports section */}
          <NavSection
            label={t("reportsSection")}
            open={reportsOpen}
            onToggle={() => setReportsOpen((v) => !v)}
          >
            <NavLink href={`/${locale}/reports`} label={t("reports")} />
            <NavLink href={`/${locale}/audit`} label={t("audit")} />
          </NavSection>

          {/* Separator + OWNER-only links */}
          <div className="border-t border-border my-2" />
          {isOwner && (
            <>
              <NavLink href={`/${locale}/import`} label={t("import")} />
              <NavLink href={`/${locale}/settings`} label={t("settings")} />
            </>
          )}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
          <div className="text-sm text-textSecondary">{user.name}</div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              {tCommon("logout")}
            </Button>
          </div>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
