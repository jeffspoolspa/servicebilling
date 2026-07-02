import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

/**
 * GET /api/maintenance-billing/visits?customer_id=123&month=YYYY-MM
 *
 * Per-visit detail for the Bills row expansion (fetched lazily on expand):
 * one row per service day with readings + chemicals sold, via
 * public.maint_billing_customer_visits.
 */
export async function GET(req: NextRequest) {
  const guard = await guardApi("maintenance")
  if (guard instanceof NextResponse) return guard

  const sp = req.nextUrl.searchParams
  const customerId = parseInt(sp.get("customer_id") ?? "", 10)
  const month = sp.get("month") ?? ""
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return NextResponse.json({ error: "customer_id required" }, { status: 400 })
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 })
  }

  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("maint_billing_customer_visits", {
    p_customer_id: customerId,
    p_month: `${month}-01`,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ days: data ?? [] })
}
