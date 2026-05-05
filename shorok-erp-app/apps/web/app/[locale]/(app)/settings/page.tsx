import { redirect } from "next/navigation";

export default function SettingsIndex({
  params: { locale },
}: {
  params: { locale: string };
}) {
  redirect(`/${locale}/settings/users`);
}
