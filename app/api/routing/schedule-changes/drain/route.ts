import { NextResponse } from "next/server"
import { authorize } from "@/lib/api/authorize"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { PublishService } from "@/lib/routing/application/publish-service"
import { SupabaseTaskStore } from "@/lib/routing/infrastructure/supabase-task-store"
import { SupabaseScenarioRepository, type ScenarioClient } from "@/lib/routing/infrastructure/supabase-scenario-repository"
import { SupabaseMaintenanceEventLog } from "@/lib/maintenance/infrastructure/supabase-event-log"
import { TaskCacheRefresher } from "@/lib/maintenance/infrastructure/task-cache-refresher"
import { IonTasks } from "@/lib/external/ion/ion"
import { IonTaskAcl } from "@/lib/external/ion/acl"
import { withIonLease, IonLeaseBusy, type LeaseRpc } from "@/lib/external/ion/session-lease"
import { triggerScriptSync } from "@/lib/windmill"
import type { QueryClient } from "@/lib/routing/infrastructure/supabase-quota-repository"

/**
 * Drain queued schedule changes. The thing that makes the queue more than a
 * to-do list nobody reads.
 *
 * Runs on a schedule AND can be poked by the publish button: a person who
 * just clicked should not wait out a cron tick, and a person who closed the
 * tab should still have their change applied. Both call the same drain, and
 * the ION lease makes a double-call harmless — the loser simply finds nothing
 * to claim, because claiming is FOR UPDATE SKIP LOCKED.
 *
 * ONE unit per invocation. A publish takes tens of seconds against ION and
 * this is a serverless function with a wall clock; finishing one change
 * honestly beats timing out halfway through the third.
 */
export const maxDuration = 300

export async function POST(req: Request) {
  // Either an authenticated operator (the publish button poking it) or the
  // scheduler carrying the cron secret. Nothing else drains ION.
  if (!(await authorize(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const sys = createSupabaseAdmin()
  const m = sys.schema("maintenance")

  const { data, error } = await m.rpc("claim_schedule_change", {})
  if (error) return NextResponse.json({ error: `claim failed: ${error.message}` }, { status: 500 })
  const row = (Array.isArray(data) ? data[0] : data) as
    { id: string; task_id: string; scenario_id: string | null; attempts: number } | undefined
  if (!row) return NextResponse.json({ drained: 0, detail: "queue empty" })

  const ion = new IonTasks({
    mint: async (forceRefresh) =>
      triggerScriptSync("f/ION/api/get_session", { force_refresh: forceRefresh }, { timeoutMs: 180000 }),
  })
  const acl = new IonTaskAcl()
  const service = new PublishService(
    new SupabaseScenarioRepository(sys as unknown as ScenarioClient),
    new SupabaseTaskStore(
      sys as unknown as QueryClient,
      sys as unknown as QueryClient,
      new TaskCacheRefresher(sys as unknown as QueryClient, ion, acl),
    ),
    ion, acl,
    new SupabaseMaintenanceEventLog(sys as unknown as ConstructorParameters<typeof SupabaseMaintenanceEventLog>[0]),
  )

  try {
    if (!row.scenario_id) throw new Error("queue row has no scenario — nothing to publish")
    const out = await withIonLease(
      m as unknown as LeaseRpc,
      `drain:${row.id}`, `schedule change ${row.task_id.slice(0, 8)}`,
      async (lease) => { ion.withLease(lease); return service.publish(row.scenario_id!, { dryRun: false }) },
      { waitMs: 60_000, pollMs: 5_000, attempts: 2 },
    )
    const mine = out.results.find((r) => r.quotaId === row.task_id) ?? out.results[0]
    if (!mine?.accepted) throw new Error(mine?.detail ?? "no result for this task")

    await m.rpc("finish_schedule_change", {
      p_id: row.id, p_error: null,
      p_result_ion_task_id: mine.ionTaskId ?? null,
      p_result_task_id: mine.taskId ?? null,
    })
    return NextResponse.json({ drained: 1, taskId: row.task_id, detail: mine.detail, ionTaskId: mine.ionTaskId ?? null })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // A busy lease is not a failure of THIS change — hand it back with its
    // budget intact so a contended session cannot dead-letter honest work.
    if (err instanceof IonLeaseBusy) {
      await m.rpc("release_schedule_change", { p_id: row.id })
      return NextResponse.json({ drained: 0, detail: `ION busy, requeued: ${detail}`, retryable: true })
    }
    // Re-claimable until attempts >= 3, then it dead-letters and STAYS
    // VISIBLE — a half-applied supersede must be findable, not swallowed.
    await m.rpc("finish_schedule_change", { p_id: row.id, p_error: detail })
    return NextResponse.json({ drained: 0, taskId: row.task_id, error: detail }, { status: 200 })
  }
}

/** Vercel cron issues GET. Same work, same guard. */
export async function GET(req: Request) {
  return POST(req)
}
