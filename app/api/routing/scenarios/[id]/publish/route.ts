import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
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
 * Publish a scenario to ION (ADR 012 shape). This route only wires ports;
 * the sentence lives in PublishService, ION quirks in IonTasks, translation
 * in the ACL. dry_run is the default; a live write is explicit.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { dry_run?: boolean }
  const dryRun = body.dry_run !== false

  const sys = createSupabaseAdmin() // system writes: the system correcting itself

  // A LIVE publish is queued, never run inside this request. On 2026-08-05 a
  // browser's fetch timed out after the server had closed a contract and
  // before it created the successor; the work existed only inside that HTTP
  // request, so nothing retried and the customer was left with no live task.
  // The client now gets row ids to watch — see v_schedule_change_queue.
  //
  // A DRY RUN still runs inline: it writes nothing, the caller is a person
  // waiting on a preview, and there is nothing to survive.
  if (!dryRun) {
    // Through the repository, never a hand-rolled query: it already knows the
    // scenarios live in `maintenance` and how a stored change is shaped. The
    // first cut guessed `routing.scenarios` and turned every live publish into
    // "no scenario <id>".
    const stored = await new SupabaseScenarioRepository(sb as unknown as ScenarioClient).byId(id)
    if (!stored) return NextResponse.json({ error: `no scenario ${id}` }, { status: 404 })
    if (stored.status !== "pending") {
      return NextResponse.json({ error: `scenario is ${stored.status} — only pending publishes` }, { status: 409 })
    }
    const taskIds = [...new Set(stored.changes.map((c) => c.quotaId))]
    if (taskIds.length === 0) return NextResponse.json({ error: "scenario changes nothing" }, { status: 400 })

    // Name the target now. Which contract is being ended is the decision the
    // operator just approved; re-deriving it at drain time risks acting on a
    // different task than the one they saw.
    const { data: known } = await sys.schema("maintenance").from("tasks")
      .select("id, ion_task_id").in("id", taskIds)
    const ionOf = new Map(((known ?? []) as { id: string; ion_task_id: string | null }[])
      .map((t) => [t.id, t.ion_task_id]))

    const queued: { taskId: string; queueId: string }[] = []
    for (const taskId of taskIds) {
      const { data: qid, error } = await sys.schema("maintenance")
        .rpc("enqueue_schedule_change", {
          p_task_id: taskId, p_scenario_id: id,
          p_ion_task_id: ionOf.get(taskId) ?? null,
          p_intent: { requested_by: user.id, scenario_id: id },
        })
      if (error) return NextResponse.json({ error: `enqueue failed: ${error.message}` }, { status: 500 })
      queued.push({ taskId, queueId: qid as string })
    }
    // 202: accepted, not done. The client watches the rows.
    return NextResponse.json({ scenarioId: id, queued, watch: "maintenance.v_schedule_change_queue" }, { status: 202 })
  }

  const ion = new IonTasks({
    mint: async (forceRefresh) =>
      triggerScriptSync("f/ION/api/get_session", { force_refresh: forceRefresh }, { timeoutMs: 180000 }),
  })
  const acl = new IonTaskAcl()
  const service = new PublishService(
    new SupabaseScenarioRepository(sb as unknown as ScenarioClient),
    new SupabaseTaskStore(
      sb as unknown as QueryClient,
      sys as unknown as QueryClient,
      new TaskCacheRefresher(sys as unknown as QueryClient, ion, acl),
    ),
    ion,
    acl,
    new SupabaseMaintenanceEventLog(sys as unknown as ConstructorParameters<typeof SupabaseMaintenanceEventLog>[0]),
  )

  try {
    // ION is one shared session and every call primes it, so a publish holds
    // the lease for its whole span — read, POST and read-back must all happen
    // under the context we established. `ion.withLease` makes each prime
    // assert we still own it. Waiting is bounded: a publish is a person
    // watching a button, so it should say "ION is busy" rather than hang.
    const out = await withIonLease(
      sys.schema("maintenance") as unknown as LeaseRpc,
      `publish:${id}`,
      `publish scenario ${id}${dryRun ? " (dry run)" : ""}`,
      async (lease) => {
        // Hand the lease to the ION client: every prime then proves we still
        // hold the session before it mutates server-side context.
        ion.withLease(lease)
        return service.publish(id, { dryRun })
      },
      { waitMs: 60_000, pollMs: 3_000, attempts: 2 },
    )
    return NextResponse.json(out)
  } catch (err) {
    if (err instanceof IonLeaseBusy) {
      // 409: nothing is wrong, someone else holds ION. Retrying later works.
      return NextResponse.json({ error: err.message, retryable: true }, { status: 409 })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
