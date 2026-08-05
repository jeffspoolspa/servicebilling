import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { authorize } from "@/lib/api/authorize"
import { RoutingService } from "@/lib/routing/application/routing-service"
import {
  SupabaseQuotaRepository,
  type QueryClient,
} from "@/lib/routing/infrastructure/supabase-quota-repository"
import {
  SupabaseScenarioRepository,
  type ScenarioClient,
} from "@/lib/routing/infrastructure/supabase-scenario-repository"
import { weekOf, type RoutingEvent } from "@/lib/routing/domain"

/**
 * Pending scenarios, each appraised against TODAY'S live plan — net weekly
 * minutes of the changes that still apply, and how many were invalidated by
 * the world moving underneath. Session-gated (internal app).
 */
export async function GET(req: Request) {
  if (!(await authorize(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const sb = await createSupabaseServer()

  const scenarios = new SupabaseScenarioRepository(sb as unknown as ScenarioClient)
  const service = new RoutingService(new SupabaseQuotaRepository(sb as unknown as QueryClient))
  const pending = await scenarios.list("pending")
  const evaluated = await service.evaluateScenarios(pending)
  return NextResponse.json({ scenarios: evaluated })
}

/**
 * Save a scenario. Two ways in, because a change list and an INTENT are
 * different things:
 *
 *   { changes: RoutingEvent[] }  the map, which already holds the live plan
 *   { moves: [{ quotaId, weekday, techId }] }  anything else
 *
 * A StopMoved needs where the pool is moving FROM, and only the live plan
 * knows. Resolving that here is what lets a terminal — or a change list typed
 * from a sheet — stage the same scenario the map does, without re-deriving
 * the plan on the client. State where it should GO; the server reads where it
 * is.
 */
export async function POST(req: Request) {
  if (!(await authorize(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const sb = await createSupabaseServer()

  const body = (await req.json()) as {
    name?: string
    changes?: RoutingEvent[]
    moves?: { quotaId: string; weekday: number; techId: string }[]
  }
  if (!body.name?.trim()) return NextResponse.json({ error: "need a name" }, { status: 400 })

  let changes = body.changes ?? []
  const refused: string[] = []

  if (!body.changes?.length && body.moves?.length) {
    const quotas = await new SupabaseQuotaRepository(sb as unknown as QueryClient).liveIn(weekOf(new Date()))
    const byId = new Map(quotas.map((q) => [q.id, q]))
    for (const mv of body.moves) {
      const quota = byId.get(mv.quotaId)
      if (!quota) { refused.push(`${mv.quotaId.slice(0, 8)}: not in the live plan`); continue }
      const from = quota.stops[0]
      if (!from) { refused.push(`${mv.quotaId.slice(0, 8)}: has no stop to move`); continue }
      if (from.weekday === mv.weekday && from.techId === mv.techId) continue   // already there
      changes.push({
        kind: "StopMoved", quotaId: mv.quotaId,
        from: { techId: from.techId, weekday: from.weekday },
        to: { techId: mv.techId, weekday: mv.weekday },
      } as unknown as RoutingEvent)
    }
    // A move we cannot place is never silently dropped: staging half a plan
    // and calling it the plan is how a pool goes unserviced.
    if (refused.length > 0) {
      return NextResponse.json({ error: `cannot stage: ${refused.join("; ")}` }, { status: 400 })
    }
  }

  if (changes.length === 0) {
    return NextResponse.json({ error: "nothing to stage — every move is already in place" }, { status: 400 })
  }
  const scenarios = new SupabaseScenarioRepository(sb as unknown as ScenarioClient)
  const stored = await scenarios.create(body.name.trim(), changes)
  return NextResponse.json({ scenario: stored, staged: changes.length })
}
