import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

/**
 * POST /api/maintenance-billing/preprocess
 * { qbo_customer_id: string, billing_month: 'YYYY-MM' }
 *
 * Immediate preprocess retry: enqueues the customer-month (dedup on the live
 * queue) so the drainer picks it up on its next 2-minute tick — the manual
 * fast path past the 30-minute self-heal spacing for sticky op errors.
 */
export async function POST(req: NextRequest) {
  const guard = await guardApi("maintenance", { write: true })
  if (guard instanceof NextResponse) return guard

  const body = await req.json().catch(() => ({}))
  const id = typeof body.qbo_customer_id === "string" ? body.qbo_customer_id : ""
  const month = typeof body.billing_month === "string" ? body.billing_month : ""
  if (!id || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json(
      { error: "qbo_customer_id and billing_month (YYYY-MM) required" },
      { status: 400 },
    )
  }

  const sb = await createSupabaseServer()
  const { error } = await sb.rpc("maint_billing_enqueue_preprocess", {
    p_qbo_customer_id: id,
    p_month: `${month}-01`,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
