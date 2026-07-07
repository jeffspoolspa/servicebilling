import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

/**
 * Pool watchlist (maintenance.task_watchlist).
 * POST { action: "add", period_ids, reason, priority?, note? } -> { added }
 * POST { action: "resolve", id, note? }                        -> { resolved }
 */
export async function POST(req: NextRequest) {
  const guard = await guardApi("maintenance", { write: true })
  if (guard instanceof NextResponse) return guard

  const body = await req.json().catch(() => ({}))
  const sb = await createSupabaseServer()

  if (body.action === "add") {
    const ids = Array.isArray(body.period_ids)
      ? body.period_ids.filter((x: unknown): x is string => typeof x === "string")
      : []
    const priority = [1, 2, 3].includes(body.priority) ? body.priority : 2
    if (ids.length === 0 || typeof body.reason !== "string") {
      return NextResponse.json({ error: "period_ids and reason required" }, { status: 400 })
    }
    const { data, error } = await sb.rpc("maint_watchlist_add", {
      p_period_ids: ids,
      p_reason: body.reason,
      p_priority: priority,
      p_note: body.note ?? null,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ added: data ?? 0 })
  }

  if (body.action === "resolve") {
    const id = Number(body.id)
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })
    const { data, error } = await sb.rpc("maint_watchlist_resolve", {
      p_id: id,
      p_note: body.note ?? null,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ resolved: data === true })
  }

  return NextResponse.json({ error: "action must be add|resolve" }, { status: 400 })
}
