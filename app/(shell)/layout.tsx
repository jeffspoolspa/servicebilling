import { Sidebar } from "@/components/shell/sidebar"
import { ModuleHeader } from "@/components/shell/module-header"

/**
 * Shell layout — wraps every page inside the (shell) route group.
 *
 * New IA (after the consolidation):
 *   ┌─ Sidebar (collapsible) ─┬─ ModuleHeader (top strip) ───────────────┐
 *   │  Home / Service /       │  Module nav (e.g. Dashboard | Billing)   │
 *   │  Maintenance / Admin    ├──────────────────────────────────────────┤
 *   │                         │  Page content                            │
 *   └─────────────────────────┴──────────────────────────────────────────┘
 *
 * Sidebar width is controlled by Sidebar itself (collapsed=56px / expanded
 * ≈208px). We use flexbox here so the collapse animation doesn't fight a
 * fixed grid column.
 */
export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <ModuleHeader />
        <main className="flex-1 flex flex-col min-w-0">{children}</main>
      </div>
    </div>
  )
}
