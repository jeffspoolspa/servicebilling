import { requireModuleAccess } from "@/lib/auth/access"

/** Service-module guard for the customers explorer. */
export default async function CustomersLayout({ children }: { children: React.ReactNode }) {
  await requireModuleAccess("service")
  return <>{children}</>
}
