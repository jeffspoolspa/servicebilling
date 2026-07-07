import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

/**
 * Pool watchlist (maintenance.task_watchlist).
 * POST { action: "add", period_ids, reason, priority?, note? } -> { added }
 * POST { action: "resolve", id, note? }                        -> { resolved }
 * POST { action: "delete", id }                                -> { deleted }
 * POST { action: "add_reason", label }                         -> { key, label }
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
    const priority = [1, 2, 3, 4].includes(body.priority) ? body.priority : 3
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

  if (body.action === "delete") {
    const id = Number(body.id)
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })
    const { data, error } = await sb.rpc("maint_watchlist_delete", { p_id: id })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ deleted: data === true })
  }

  if (body.action === "add_reason") {
    const label = String(body.label ?? "").trim()
    if (label.length < 2) return NextResponse.json({ error: "label required" }, { status: 400 })
    const { data, error } = await sb.rpc("maint_watchlist_create_reason", { p_label: label })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const row = (data ?? [])[0]
    return NextResponse.json(row ?? { error: "create failed" })
  }

  return NextResponse.json({ error: "action must be add|resolve|delete|add_reason" }, { status: 400 })
}
