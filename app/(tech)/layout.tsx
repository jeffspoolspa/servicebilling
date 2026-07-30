import { ModuleTabs } from "./ModuleTabs"
import { BottomNav } from "./BottomNav"
import { TechMenu } from "./TechMenu"
import { BottomBarProvider } from "./bottom-bar"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"
import { isFollowUpOnly } from "@/lib/auth/tech-scope"

export default async function TechLayout({ children }: { children: React.ReactNode }) {
  const employee = await getCurrentEmployee()
  const isAuthedMaintenance =
    !!employee && employee.department_id === MAINTENANCE_DEPARTMENT_ID
  const followUpOnly = isAuthedMaintenance && (await isFollowUpOnly(employee))

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-5 py-3.5 border-b border-line-soft flex items-center gap-3">
        <TechMenu
          techName={
            isAuthedMaintenance
              ? [employee.first_name, employee.last_name].filter(Boolean).join(" ") || null
              : null
          }
        />
        <div className="font-display text-lg tracking-tight">Field</div>
      </header>
      {isAuthedMaintenance ? (
        <BottomBarProvider>
          <ModuleTabs />
          {/* pb leaves room for the fixed bottom nav / submit button */}
          <main className="flex-1 w-full max-w-md mx-auto px-5 py-6 pb-28">{children}</main>
          <BottomNav hideInventory={followUpOnly} />
        </BottomBarProvider>
      ) : (
        <main className="flex-1 w-full max-w-md mx-auto px-5 py-6">{children}</main>
      )}
    </div>
  )
}
