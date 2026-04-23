import { redirect } from "next/navigation"

/**
 * Root "/" now redirects to /service — the Service Dashboard is the
 * landing view for the app after the UI consolidation. Any stale
 * bookmarks / links pointing at "/" seamlessly land on the dashboard.
 */
export default function HomePage() {
  // `as never` because Next.js's typedRoutes union hasn't picked up
  // /service yet — only resolves after next dev/build regenerates .next/types
  redirect("/service" as never)
}
