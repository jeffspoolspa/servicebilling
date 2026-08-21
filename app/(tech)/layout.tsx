import { ModuleTabs } from "./ModuleTabs"
import { BottomNav } from "./BottomNav"
import { TechMenu } from "./TechMenu"
import { BottomBarProvider } from "./bottom-bar"
import { TopBarProvider, TopBarSlot } from "./top-bar"
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

  // Thin context bar (ruled 2026-08-21): the strip stays for the drawer
  // trigger and the iOS top safe-area, but its width belongs to the page —
  // useTopBar().setContent claims it; empty pages just show the wordmark.
  return (
    <TopBarProvider>
      <div className="min-h-screen flex flex-col">
        <header className="px-4 h-11 pt-[env(safe-area-inset-top)] box-content border-b border-line-soft flex items-center gap-2.5">
          <TechMenu
            techName={techName}
            showModules={isAuthedMaintenance}
            hideInventory={followUpOnly}
          />
          <TopBarSlot />
        </header>
        {isAuthedMaintenance ? (
          <BottomBarProvider>
            <ModuleTabs />
            {/* pb leaves room for the fixed bottom action bar */}
            <main className="flex-1 w-full max-w-md mx-auto px-5 py-5 pb-28">{children}</main>
            <BottomNav hideInventory={followUpOnly} />
          </BottomBarProvider>
        ) : (
          <main className="flex-1 w-full max-w-md mx-auto px-5 py-6">{children}</main>
        )}
      </div>
    </TopBarProvider>
  )
}
