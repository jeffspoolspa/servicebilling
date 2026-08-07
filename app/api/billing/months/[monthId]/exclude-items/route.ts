import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

/**
 * NON-BILLABLE marking (RULED 2026-08-07): any billable item can be
 * excluded — it stays on the ledger (the work happened; reconcile still
 * counts it against ION) but never reaches an invoice. task_id marks the
 * task's WHOLE month. Only unlocked items (no invoice yet) can change.
 */
export async function POST(req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { item_ids?: string[]; task_id?: string; exclude?: boolean }
  const exclude = body.exclude !== false
  const itemIds = (body.item_ids ?? []).filter((v) => /^[0-9a-f-]{36}$/.test(v))
  const taskId = body.task_id && /^[0-9a-f-]{36}$/.test(body.task_id) ? body.task_id : null
  if (itemIds.length === 0 && !taskId) return NextResponse.json({ error: "nothing to mark" }, { status: 400 })

  const sys = createSupabaseAdmin()
  const { data: bmRows } = await (sys.schema("billing").from("billing_months") as never as {
    select(c: string): { eq(k: string, v: string): PromiseLike<{ data: unknown[] | null }> }
  }).select("id, invoiced_at").eq("id", monthId)
  const bm = ((bmRows ?? [])[0] ?? null) as { invoiced_at: string | null } | null
  if (!bm) return NextResponse.json({ error: "month not found" }, { status: 404 })
  if (bm.invoiced_at) return NextResponse.json({ error: "already invoiced — the ledger is frozen; record a variance instead" }, { status: 409 })

  type Upd = {
    update(v: Record<string, unknown>): Upd
    eq(c: string, v: unknown): Upd
    is(c: string, v: null): Upd
    in(c: string, v: string[]): Upd
    select(c: string): PromiseLike<{ data: unknown[] | null; error: unknown }>
  }
  let q = (sys.schema("billing").from("billable_items") as unknown as Upd)
    .update(exclude
      ? { excluded_at: new Date().toISOString(), excluded_by: user.email ?? user.id }
      : { excluded_at: null, excluded_by: null })
    .eq("billing_month_id", monthId)
    .is("qbo_invoice_id", null)
  q = taskId ? q.eq("task_id", taskId) : q.in("id", itemIds)
  const { data, error } = await q.select("id")
  if (error) return NextResponse.json({ error: JSON.stringify(error).slice(0, 200) }, { status: 500 })
  const count = (data ?? []).length

  const { error: evErr } = await (sys.schema("maintenance") as never as {
    rpc(f: string, a: Record<string, unknown>): PromiseLike<{ error: unknown }>
  }).rpc("append_event", {
    p_aggregate: "billing_month",
    p_aggregate_id: monthId,
    p_type: exclude ? "MonthItemsExcluded" : "MonthItemsRestored",
    p_payload: { count, task_id: taskId, item_ids: taskId ? undefined : itemIds },
    p_actor: user.email ?? user.id,
    p_participants: [monthId],
    p_occurred_at: new Date().toISOString(),
  })
  if (evErr) console.error(`exclusion fact not appended: ${JSON.stringify(evErr).slice(0, 200)}`)

  return NextResponse.json({ [exclude ? "excluded" : "restored"]: count })
}
