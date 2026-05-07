import { Sidebar } from "@/components/shell/sidebar"
import { ModuleHeader } from "@/components/shell/module-header"
import { PreProcessActivity } from "@/components/shell/pre-process-activity"
import { WebhookExpectationsActivity } from "@/components/shell/webhook-expectations-activity"
import { RealtimeBridge } from "@/components/shell/realtime-bridge"
import { AccessProvider } from "@/components/providers/access-provider"
import { getUserAccess } from "@/lib/auth/access"

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
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  // Loaded once per request server-side; passed to client via context so any
  // component can ask "can the current user write to this module?" without
  // re-hitting the DB. Cached via React.cache(), so individual page guards
  // calling requireModuleAccess() don't refetch either.
  const access = await getUserAccess()
  const accessSnapshot = access
    ? {
        authUserId: access.authUserId,
        email: access.email,
        modules: access.modules,
      }
    : null

  return (
    <AccessProvider value={accessSnapshot}>
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <ModuleHeader />
          <main className="flex-1 flex flex-col min-w-0">{children}</main>
        </div>
        {/* Global pre-processing activity toast — fixed-positioned, only
            renders when there's pre-process work in flight (single re-run,
            bulk re-run, sync-from-QBO trigger cascade, anywhere). */}
        <PreProcessActivity />
        {/* Webhook confirmations toast — fixed bottom-right, stacked above
            PreProcessActivity. Surfaces user-initiated writes that are
            waiting for QBO to confirm via webhook. Spinner while pending,
            green check when confirmed (auto-fades), red when grace window
            expires without a webhook (cdc_reconciler flips to 'missing'). */}
        <WebhookExpectationsActivity />
        {/* Realtime → TanStack Query bridge. Mounts once, invalidates query
            keys when the underlying tables change in Postgres. Pages using
            useQuery on the registered key prefixes become live for free. */}
        <RealtimeBridge />
      </div>
    </AccessProvider>
  )
}
