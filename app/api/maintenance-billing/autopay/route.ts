import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

/**
 * Autopay roster management.
 *
 * GET  ?pms_for=<qbo_customer_id>  → the customer's active payment methods
 * POST { action: 'add' | 'set_pm' | 'remove', qbo_customer_id,
 *        payment_method_id? }      → guarded roster RPCs (soft remove)
 */
export async function GET(req: NextRequest) {
  const guard = await guardApi("maintenance")
  if (guard instanceof NextResponse) return guard
  const id = req.nextUrl.searchParams.get("pms_for") ?? ""
  if (!id) return NextResponse.json({ error: "pms_for required" }, { status: 400 })
  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("maint_billing_customer_pms", {
    p_qbo_customer_id: id,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ payment_methods: data ?? [] })
}

export async function POST(req: NextRequest) {
  const guard = await guardApi("maintenance", { write: true })
  if (guard instanceof NextResponse) return guard
  const body = await req.json().catch(() => ({}))
  const { action, qbo_customer_id, payment_method_id } = body
  if (!qbo_customer_id || !["add", "set_pm", "remove"].includes(action)) {
    return NextResponse.json(
      { error: "action (add|set_pm|remove) and qbo_customer_id required" },
      { status: 400 },
    )
  }
  if (action !== "remove" && !payment_method_id) {
    return NextResponse.json({ error: "payment_method_id required" }, { status: 400 })
  }

  const sb = await createSupabaseServer()
  const fn =
    action === "add"
      ? "maint_billing_autopay_add"
      : action === "set_pm"
        ? "maint_billing_autopay_set_pm"
        : "maint_billing_autopay_remove"
  const args: Record<string, unknown> = { p_qbo_customer_id: qbo_customer_id }
  if (action !== "remove") args.p_payment_method_id = payment_method_id
  const { data, error } = await sb.rpc(fn, args)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: data === true })
}
