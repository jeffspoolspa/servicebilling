import { ModuleTabs } from "./ModuleTabs"
import { BottomNav } from "./BottomNav"
import { TechMenu } from "./TechMenu"
import { TopPills } from "./TopPills"
import { BottomBarProvider } from "./bottom-bar"
import { TopBarProvider } from "./top-bar"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { canUseTechApp } from "@/lib/auth/tech-app"
import { isFollowUpOnly } from "@/lib/auth/tech-scope"

export default async function TechLayout({ children }: { children: React.ReactNode }) {
  const employee = await getCurrentEmployee()
  const isAuthedMaintenance = await canUseTechApp(employee)
  const followUpOnly = isAuthedMaintenance && (await isFollowUpOnly(employee))

  const techName = isAuthedMaintenance
    ? [employee.first_name, employee.last_name].filter(Boolean).join(" ") || null
    : null

  // No header row at all (ruled 2026-08-21): frosted pills float over the
  // content — drawer trigger left, page-claimed context centre, live
  // connectivity right. The column pads under them + the iOS safe-area.
  return (
    <TopBarProvider>
      <div
        className="min-h-screen flex flex-col"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 58px)" }}
      >
        <TopPills
          techName={techName}
          menu={
            <TechMenu
              techName={techName}
              showModules={isAuthedMaintenance}
              hideInventory={followUpOnly}
            />
          }
        />
        {isAuthedMaintenance ? (
          <BottomBarProvider>
            <ModuleTabs />
            {/* pb leaves room for the fixed bottom action bar */}
            <main className="flex-1 w-full max-w-md mx-auto px-5 pt-1 pb-28">{children}</main>
            <BottomNav hideInventory={followUpOnly} />
          </BottomBarProvider>
        ) : (
          <main className="flex-1 w-full max-w-md mx-auto px-5 pt-1 pb-6">{children}</main>
        )}
      </div>
    </TopBarProvider>
  )
}
