import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

/**
 * GET /api/maintenance-billing/invoice?qbo_invoice_id=123
 *
 * One cached QBO invoice's header + line items (billing.invoices via the
 * maint_billing_invoice_detail definer RPC) for the Ready to Process
 * drill-down. Balance reflects the cache — credits applied moments ago land
 * after the next webhook/CDC tick.
 */
export async function GET(req: NextRequest) {
  const guard = await guardApi("maintenance")
  if (guard instanceof NextResponse) return guard

  const id = req.nextUrl.searchParams.get("qbo_invoice_id") ?? ""
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: "qbo_invoice_id required" }, { status: 400 })
  }

  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("maint_billing_invoice_detail", {
    p_qbo_invoice_id: id,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  const row = (data ?? [])[0]
  if (!row) return NextResponse.json({ error: "invoice not in cache" }, { status: 404 })
  return NextResponse.json({ invoice: row })
}
