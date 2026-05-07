import { requireModuleAccess } from "@/lib/auth/access"

/** Service-module guard for the work orders explorer. */
export default async function WorkOrdersLayout({ children }: { children: React.ReactNode }) {
  await requireModuleAccess("service")
  return <>{children}</>
}
