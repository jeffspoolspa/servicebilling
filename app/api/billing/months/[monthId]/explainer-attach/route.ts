import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

/**
 * ATTACH INTENT: point this month's invoices at the saved explainer so the
 * SEND path attaches it when emailing (the QBO upload happens there, not
 * here — recording intent never touches QBO). LOCKED once any invoice has
 * been emailed: you don't add something to an already-sent invoice. The
 * explainer itself can still be generated any time.
 */
export async function POST(req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { attach?: boolean }
  const sys = createSupabaseAdmin()

  const { data: bmRows } = await (sys.schema("billing").from("billing_months") as never as {
    select(c: string): { eq(k: string, v: string): PromiseLike<{ data: unknown[] | null }> }
  }).select("id, explainer_generated_at").eq("id", monthId)
  const bm = ((bmRows ?? [])[0] ?? null) as { id: string; explainer_generated_at: string | null } | null
  if (!bm) return NextResponse.json({ error: "month not found" }, { status: 404 })
  if (body.attach !== false && !bm.explainer_generated_at) {
    return NextResponse.json({ error: "generate the explainer first" }, { status: 409 })
  }

  // The lock: any emailed invoice on this month freezes the attach decision.
  const { data: sentRows } = await (sys.schema("billing").from("month_invoices") as never as {
    select(c: string): { eq(k: string, v: string): PromiseLike<{ data: unknown[] | null }> }
  }).select("qbo_invoice_id").eq("billing_month_id", monthId)
  const ids = ((sentRows ?? []) as { qbo_invoice_id: string }[]).map((r) => r.qbo_invoice_id)
  if (ids.length > 0) {
    const { data: inv } = await (sys.schema("billing").from("invoices") as never as {
      select(c: string): { in(k: string, v: string[]): PromiseLike<{ data: unknown[] | null }> }
    }).select("qbo_invoice_id, email_status").in("qbo_invoice_id", ids)
    const sent = ((inv ?? []) as { email_status: string | null }[]).some((r) => r.email_status === "EmailSent")
    if (sent) return NextResponse.json({ error: "locked — this month's invoices have already been sent" }, { status: 409 })
  }

  const upd = sys.schema("billing").from("billing_months") as never as {
    update(v: Record<string, unknown>): { eq(k: string, v2: string): PromiseLike<{ error: unknown }> }
  }
  const { error } = await upd
    .update({ explainer_attach_requested_at: body.attach === false ? null : new Date().toISOString() })
    .eq("id", monthId)
  if (error) return NextResponse.json({ error: JSON.stringify(error).slice(0, 200) }, { status: 500 })
  return NextResponse.json({ attached: body.attach !== false })
}
