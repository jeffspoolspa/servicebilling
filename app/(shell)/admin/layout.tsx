import { requireModuleAccess } from "@/lib/auth/access"

/**
 * Admin module guard. Only users with an `app_roles` row of (admin, admin)
 * can hit anything under /admin/*. Service viewers are bounced to /unauthorized.
 *
 * Inside admin pages, the guard alone gates access. Per-action write
 * authorization is enforced again at the action / RPC level.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireModuleAccess("admin")
  return <>{children}</>
}
