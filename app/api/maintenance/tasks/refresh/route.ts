import { NextResponse } from "next/server"
import { authorize } from "@/lib/api/authorize"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { TaskService } from "@/lib/maintenance/application/task-service"
import { SupabaseTaskRepository } from "@/lib/maintenance/infrastructure/supabase-task-repository"
import { TaskCacheRefresher } from "@/lib/maintenance/infrastructure/task-cache-refresher"
import { RefresherFreshness } from "@/lib/maintenance/infrastructure/cache-freshness"
import { IonTaskRoster } from "@/lib/maintenance/infrastructure/ion-task-roster"
import { IonTasks } from "@/lib/external/ion/ion"
import { IonTaskAcl } from "@/lib/external/ion/acl"
import { SupabaseMaintenanceEventLog } from "@/lib/maintenance/infrastructure/supabase-event-log"
import { withIonLease, IonLeaseBusy, type LeaseRpc } from "@/lib/external/ion/session-lease"
import { triggerScriptSync } from "@/lib/windmill"

/**
 * Make our copy of these tasks true, on demand.
 *
 * The button behind "something looks off" on the map: the user selects a
 * customer, we re-read their tasks from ION and reconcile — including noticing
 * a task deleted outside our system, which no other signal can see.
 *
 * POST { taskIds: string[] }  or  { customerId: number } for all of theirs.
 */
export async function POST(req: Request) {
  const caller = await authorize(req)
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { taskIds?: string[]; customerId?: number }
  const sys = createSupabaseAdmin()

  let taskIds = body.taskIds ?? []
  if (taskIds.length === 0 && body.customerId) {
    const { data } = await sys.schema("maintenance").from("tasks")
      .select("id").eq("customer_id", body.customerId).neq("status", "closed")
    taskIds = ((data ?? []) as { id: string }[]).map((t) => t.id)
  }
  if (taskIds.length === 0) {
    return NextResponse.json({ error: "give taskIds or a customerId with open tasks" }, { status: 400 })
  }

  const ion = new IonTasks({
    mint: async (forceRefresh) =>
      triggerScriptSync("f/ION/api/get_session", { force_refresh: forceRefresh }, { timeoutMs: 180000 }),
  })
  const acl = new IonTaskAcl()
  const service = new TaskService(
    new SupabaseTaskRepository(sys as never),
    null as never,                                   // refresh performs no ION WRITE
    new RefresherFreshness(new TaskCacheRefresher(sys as never, ion, acl)),
    new IonTaskRoster(sys as never, ion),
    new SupabaseMaintenanceEventLog(sys as never),
  )

  try {
    // Priming is a write to ION's session context even on a read path, so a
    // refresh takes the lease like anything else. It is short, so it waits
    // rather than failing the moment a nightly sweep is running.
    const out = await withIonLease(
      sys.schema("maintenance") as unknown as LeaseRpc,
      `refresh:${caller.id}`,
      `manual refresh of ${taskIds.length} task(s)`,
      async (lease) => {
        ion.withLease(lease)
        return service.refreshTasks(taskIds)
      },
      { waitMs: 120_000, pollMs: 3_000, attempts: 2 },
    )
    return NextResponse.json(out)
  } catch (err) {
    if (err instanceof IonLeaseBusy) {
      return NextResponse.json({ error: err.message, retryable: true }, { status: 409 })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
