import { requireModuleAccess } from "@/lib/auth/access"

/** Service-module guard for the employees explorer. */
export default async function EmployeesLayout({ children }: { children: React.ReactNode }) {
  await requireModuleAccess("service")
  return <>{children}</>
}
