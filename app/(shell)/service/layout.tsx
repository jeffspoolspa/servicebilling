import { requireModuleAccess } from "@/lib/auth/access"

/**
 * Service module guard — gates /service/* (the dashboard).
 * Viewer + admin both pass; non-service users redirected to /unauthorized.
 */
export default async function ServiceLayout({ children }: { children: React.ReactNode }) {
  await requireModuleAccess("service")
  return <>{children}</>
}
