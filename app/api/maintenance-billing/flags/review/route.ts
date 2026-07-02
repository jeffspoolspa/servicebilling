import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

/**
 * POST /api/maintenance-billing/flags/review
 * Body: { customer_id: number, month: 'YYYY-MM-01', status: 'reviewed'|'resolved'|'flagged', note?: string }
 *
 * Marks a billing-audit flag (billing_audit.customer_month_audit) via the
 * public.maint_billing_flag_review SECURITY DEFINER RPC. Reviewing a HIGH
 * flag releases the autopay/send hold on that customer-month.
 */
export async function POST(req: NextRequest) {
  const guard = await guardApi("maintenance", { write: true })
  if (guard instanceof NextResponse) return guard

  let body: {
    customer_id?: number
    month?: string
    status?: string
    note?: string | null
  } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const customerId = Number(body.customer_id)
  const month = body.month ?? ""
  const status = body.status ?? ""
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return NextResponse.json({ error: "customer_id required" }, { status: 400 })
  }
  if (!/^\d{4}-\d{2}-01$/.test(month)) {
    return NextResponse.json({ error: "month must be YYYY-MM-01" }, { status: 400 })
  }
  if (!["reviewed", "resolved", "flagged"].includes(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 })
  }

  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("maint_billing_flag_review", {
    p_customer_id: customerId,
    p_month: month,
    p_status: status,
    p_note: body.note ?? null,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (data !== true) {
    return NextResponse.json(
      { error: `no flag for customer ${customerId} in ${month}` },
      { status: 404 },
    )
  }
  return NextResponse.json({ status: "ok" })
}
