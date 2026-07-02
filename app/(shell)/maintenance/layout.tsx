import { Suspense } from "react"
import { UnroutedBanner } from "./_components/unrouted-banner"
import { requireModuleAccess } from "@/lib/auth/access"

/**
 * Shared layout for every /maintenance/* sub-page. Module navigation lives
 * ONLY in the top ModuleHeader strip (components/shell/module-header.tsx) —
 * no duplicated in-page tab strip, matching service-billing. In-page tab
 * strips are reserved for stage views WITHIN a module (see billing/).
 */
export default async function MaintenanceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await requireModuleAccess("maintenance")
  return (
    <>
      <Suspense fallback={null}>
        <UnroutedBanner />
      </Suspense>

      {children}
    </>
  )
}
