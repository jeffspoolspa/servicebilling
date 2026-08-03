import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { PublishService } from "@/lib/application/routing/publish-service"
import { SupabaseTaskStore } from "@/lib/infrastructure/routing/supabase-task-store"
import { SupabaseScenarioRepository, type ScenarioClient } from "@/lib/infrastructure/routing/supabase-scenario-repository"
import { SupabaseMaintenanceEventLog } from "@/lib/infrastructure/maintenance/supabase-event-log"
import { TaskCacheRefresher } from "@/lib/infrastructure/maintenance/task-cache-refresher"
import { IonTasks } from "@/lib/infrastructure/ion/ion"
import { IonTaskAcl } from "@/lib/infrastructure/ion/acl"
import { triggerScriptSync } from "@/lib/windmill"
import type { QueryClient } from "@/lib/infrastructure/routing/supabase-quota-repository"

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
  const service = new PublishService(
    new SupabaseScenarioRepository(sb as unknown as ScenarioClient),
    new SupabaseTaskStore(
      sb as unknown as QueryClient,
      sys as unknown as QueryClient,
      new TaskCacheRefresher(sys as unknown as QueryClient, {
        run: (path, args) => triggerScriptSync(path, args, { timeoutMs: 300000 }),
      }),
    ),
    ion,
    new IonTaskAcl(),
    new SupabaseMaintenanceEventLog(sys as unknown as ConstructorParameters<typeof SupabaseMaintenanceEventLog>[0]),
  )

  try {
    return NextResponse.json(await service.publish(id, { dryRun }))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
