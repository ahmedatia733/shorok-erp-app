import { redirect } from "next/navigation";

/**
 * The Suppliers settings sub-route is a thin redirect to /<locale>/suppliers.
 * The Suppliers UI is the real surface; the Settings entry just keeps the
 * navigation discoverable per the design spec.
 */
export default function SettingsSuppliersAlias({
  params: { locale },
}: {
  params: { locale: string };
}) {
  redirect(`/${locale}/suppliers`);
}
