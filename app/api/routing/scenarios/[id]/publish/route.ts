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
      sys as unknown as LeaseRpc,
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
