import { MaintenanceTabs } from "./maintenance-tabs"
import { requireModuleAccess } from "@/lib/auth/access"

/**
 * Shared layout for every /maintenance/* sub-page. Renders persistent tabs
 * above the per-page content. Per-page content (Cards, tables, etc.)
 * renders as `children`.
 *
 * Mirrors the service-billing layout pattern but minus the KPI strip until
 * we have data to surface.
 */
export default async function MaintenanceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await requireModuleAccess("maintenance")
  return (
    <>
      <div className="px-7 pt-6 pb-2">
        <div className="flex items-center">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
              Maintenance
            </div>
            <h1 className="font-display text-[20px] mt-0.5">Service operations</h1>
          </div>
        </div>
      </div>

      <MaintenanceTabs />

      {children}
    </>
  )
}
