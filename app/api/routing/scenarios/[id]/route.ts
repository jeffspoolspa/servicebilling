import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import {
  SupabaseScenarioRepository,
  type ScenarioClient,
} from "@/lib/infrastructure/routing/supabase-scenario-repository"
import type { RoutingEvent, StoredScenario } from "@/lib/domain/routing"

/** One stored scenario, raw — the client restores it over its live plan. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const scenario = await new SupabaseScenarioRepository(sb as unknown as ScenarioClient).byId(id)
  if (!scenario) return NextResponse.json({ error: "not found" }, { status: 404 })
  return NextResponse.json({ scenario })
}

/**
 * Update a scenario: rename, replace its change list (saving while viewing),
 * or settle its fate. `committed` records the decision — the ION write-back
 * is the RoutePublisher's job and is not wired yet, deliberately.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const patch = (await req.json()) as {
    name?: string
    changes?: RoutingEvent[]
    status?: StoredScenario["status"]
  }
  if (patch.status && !["pending", "committed", "discarded"].includes(patch.status)) {
    return NextResponse.json({ error: "bad status" }, { status: 400 })
  }
  await new SupabaseScenarioRepository(sb as unknown as ScenarioClient).update(id, patch)
  return NextResponse.json({ ok: true })
}
