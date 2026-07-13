import { ModuleTabs } from "./ModuleTabs"
import { BottomNav } from "./BottomNav"
import { BottomBarProvider } from "./bottom-bar"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"

export default async function TechLayout({ children }: { children: React.ReactNode }) {
  const employee = await getCurrentEmployee()
  const isAuthedMaintenance =
    !!employee && employee.department_id === MAINTENANCE_DEPARTMENT_ID

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-5 py-3.5 border-b border-line-soft flex items-center gap-3">
        <div className="w-8 h-8 rounded-[8px] grid place-items-center bg-gradient-to-b from-cyan to-cyan-deep text-[#061018] font-display font-bold">
          J
        </div>
        <div className="font-display text-lg tracking-tight">Field</div>
      </header>
      {isAuthedMaintenance ? (
        <BottomBarProvider>
          <ModuleTabs />
          {/* pb leaves room for the fixed bottom nav / submit button */}
          <main className="flex-1 w-full max-w-md mx-auto px-5 py-6 pb-28">{children}</main>
          <BottomNav />
        </BottomBarProvider>
      ) : (
        <main className="flex-1 w-full max-w-md mx-auto px-5 py-6">{children}</main>
      )}
    </div>
  )
}
