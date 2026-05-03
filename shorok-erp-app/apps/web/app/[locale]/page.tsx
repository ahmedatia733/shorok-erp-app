import { redirect } from "next/navigation";

export default function LocaleRoot({ params: { locale } }: { params: { locale: string } }) {
  // Send authenticated and unauthenticated users to /login; the (app) layout
  // handles the redirect to /dashboard once Phase 3+ ships those routes.
  redirect(`/${locale}/login`);
}
