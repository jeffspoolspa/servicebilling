import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

/**
 * CHOOSE the month's billing type (RULED 2026-08-07): ION's task config is
 * the default; when tasks disagree the gate holds and a person records the
 * choice here. Frozen once invoiced — the documents already inherited it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { consumables?: string; presentation?: string }
  const choice: Record<string, string> = {}
  if (body.consumables !== undefined) {
    if (!["included", "separate"].includes(body.consumables)) return NextResponse.json({ error: "consumables must be included|separate" }, { status: 400 })
    choice.consumables = body.consumables
  }
  if (body.presentation !== undefined) {
    if (!["itemized", "summary"].includes(body.presentation)) return NextResponse.json({ error: "presentation must be itemized|summary" }, { status: 400 })
    choice.presentation = body.presentation
  }
  if (Object.keys(choice).length === 0) return NextResponse.json({ error: "nothing chosen" }, { status: 400 })

  const sys = createSupabaseAdmin()
  const { data: rows } = await (sys.schema("billing").from("billing_months") as never as {
    select(c: string): { eq(k: string, v: string): PromiseLike<{ data: unknown[] | null }> }
  }).select("id, invoiced_at, doc_settings_override").eq("id", monthId)
  const bm = ((rows ?? [])[0] ?? null) as { id: string; invoiced_at: string | null; doc_settings_override: Record<string, string> | null } | null
  if (!bm) return NextResponse.json({ error: "month not found" }, { status: 404 })
  if (bm.invoiced_at) return NextResponse.json({ error: "already invoiced — the documents inherited their settings" }, { status: 409 })

  const merged = { ...(bm.doc_settings_override ?? {}), ...choice }
  const upd = sys.schema("billing").from("billing_months") as never as {
    update(v: Record<string, unknown>): { eq(k: string, v2: string): PromiseLike<{ error: unknown }> }
  }
  const { error } = await upd.update({ doc_settings_override: merged }).eq("id", monthId)
  if (error) return NextResponse.json({ error: JSON.stringify(error).slice(0, 200) }, { status: 500 })

  const { error: evErr } = await (sys.schema("maintenance") as never as {
    rpc(f: string, a: Record<string, unknown>): PromiseLike<{ error: unknown }>
  }).rpc("append_event", {
    p_aggregate: "billing_month",
    p_aggregate_id: monthId,
    p_type: "MonthDocSettingsChosen",
    p_payload: { chosen: choice, override: merged },
    p_actor: user.email ?? user.id,
    p_participants: [monthId],
    p_occurred_at: new Date().toISOString(),
  })
  if (evErr) console.error(`doc-settings fact not appended: ${JSON.stringify(evErr).slice(0, 200)}`)

  return NextResponse.json({ override: merged })
}
