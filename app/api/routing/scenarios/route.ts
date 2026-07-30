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
import type { RoutingEvent } from "@/lib/domain/routing"

/**
 * Pending scenarios, each appraised against TODAY'S live plan — net weekly
 * minutes of the changes that still apply, and how many were invalidated by
 * the world moving underneath. Session-gated (internal app).
 */
export async function GET() {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const scenarios = new SupabaseScenarioRepository(sb as unknown as ScenarioClient)
  const service = new RoutingService(new SupabaseQuotaRepository(sb as unknown as QueryClient))
  const pending = await scenarios.list("pending")
  const evaluated = await service.evaluateScenarios(pending)
  return NextResponse.json({ scenarios: evaluated })
}

/** Save a change list as a named scenario. The list IS the scenario. */
export async function POST(req: Request) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { name, changes } = (await req.json()) as { name?: string; changes?: RoutingEvent[] }
  if (!name?.trim() || !Array.isArray(changes) || changes.length === 0) {
    return NextResponse.json({ error: "need a name and at least one change" }, { status: 400 })
  }
  const scenarios = new SupabaseScenarioRepository(sb as unknown as ScenarioClient)
  const stored = await scenarios.create(name.trim(), changes)
  return NextResponse.json({ scenario: stored })
}
