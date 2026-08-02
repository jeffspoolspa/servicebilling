import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { RoutingService } from "@/lib/application/routing/routing-service"
import {
  SupabaseQuotaRepository,
  type QueryClient,
} from "@/lib/infrastructure/routing/supabase-quota-repository"
import {
  SupabaseScenarioRepository,
  type ScenarioClient,
} from "@/lib/infrastructure/routing/supabase-scenario-repository"
import { IonRoutePublisher } from "@/lib/infrastructure/routing/ion-route-publisher"
import { SupabasePlacementCache } from "@/lib/infrastructure/routing/supabase-placement-cache"
import { triggerScriptSync } from "@/lib/windmill"

/**
 * Publish a scenario to ION.
 *
 * The UI hands over an id and nothing else: the service restores the scenario
 * over today's plan, refuses it if a quota's rules would break, and writes one
 * COMPLETE week per touched task so ION cannot drop the stops that did not
 * change. The next ION sync reflects the result back into the cache, which is
 * what refreshes the map.
 *
 * dry_run is the default. A live write requires { dry_run: false } explicitly,
 * and only marks the scenario committed if every task was accepted.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { dry_run?: boolean }
  const dryRun = body.dry_run !== false

  const service = new RoutingService(new SupabaseQuotaRepository(sb as unknown as QueryClient))
  const scenarios = new SupabaseScenarioRepository(sb as unknown as ScenarioClient)
  const publisher = new IonRoutePublisher(sb as unknown as QueryClient, {
    // ION work runs through chromium when the session is stale, so give it room.
    run: (path, args) => triggerScriptSync(path, args, { timeoutMs: 180000 }),
  })
  // Our copy is refreshed only for writes ION confirmed, so the map stops
  // lying before the next ION sync catches up.
  const cache = new SupabasePlacementCache(sb as unknown as QueryClient)

  try {
    const report = await service.publishScenario(id, scenarios, publisher, { dryRun, cache })
    return NextResponse.json(report)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    )
  }
}
