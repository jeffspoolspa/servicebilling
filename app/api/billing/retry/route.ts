import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"
import { triggerScript } from "@/lib/windmill"

/**
 * POST /api/billing/retry
 * Body: { wo_number: string }
 *
 * Legacy retry endpoint — kept for UI compatibility. Resolves the WO's
 * qbo_invoice_id and re-runs pre-processing on it (force=true).
 *
 * The preferred path for interactive UIs is /api/billing/pre-process
 * directly with qbo_invoice_id (saves a lookup).
 */
export async function POST(request: NextRequest) {
  const body = await request.json()
  const { wo_number } = body

  if (!wo_number) {
    return NextResponse.json({ error: "Provide wo_number" }, { status: 400 })
  }

  const sb = createAnon("public")
  const { data: wo, error } = await sb
    .from("work_orders")
    .select("qbo_invoice_id")
    .eq("wo_number", wo_number)
    .single()

  if (error || !wo) {
    return NextResponse.json({ error: "WO not found" }, { status: 404 })
  }
  if (!wo.qbo_invoice_id) {
    return NextResponse.json(
      { error: "WO has no linked invoice yet — nothing to re-process" },
      { status: 400 },
    )
  }

  const { jobId } = await triggerScript("f/service_billing/pre_process_invoice", {
    qbo_invoice_id: wo.qbo_invoice_id,
    force: true,
  })

  return NextResponse.json({ jobId, status: "triggered", wo_number })
}
