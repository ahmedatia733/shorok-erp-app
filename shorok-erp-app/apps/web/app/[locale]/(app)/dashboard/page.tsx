import { redirect } from "next/navigation";

/**
 * The full dashboard ships with US5. Until then this route exists so
 * post-login (which pushes to /<locale>/dashboard) and the sidebar link
 * land on a real page instead of 404. /orders is the headline flow per
 * the MVP spec, so that's where we send the user.
 */
export default function DashboardPlaceholder({
  params: { locale },
}: {
  params: { locale: string };
}) {
  redirect(`/${locale}/orders`);
}
