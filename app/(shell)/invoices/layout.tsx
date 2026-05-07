import { requireModuleAccess } from "@/lib/auth/access"

/** Service-module guard for the invoices explorer. */
export default async function InvoicesLayout({ children }: { children: React.ReactNode }) {
  await requireModuleAccess("service")
  return <>{children}</>
}
