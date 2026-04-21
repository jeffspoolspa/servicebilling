import { NextResponse, type NextRequest } from "next/server"
import { triggerScript } from "@/lib/windmill"

interface RouteContext {
  params: Promise<{ wo_number: string }>
}

/**
 * POST /api/work-orders/[wo_number]/sync
 *
 * Triggers f/service_billing/pull_qbo_invoices in single-WO mode:
 *   1. Looks up the WO's invoice_number
 *   2. Fetches that invoice from QBO live
 *   3. Upserts billing.invoices + links the WO via qbo_invoice_id
 *   4. Auto-chains to pre_process_invoice with force=True
 *
 * Returns the Windmill jobId immediately. Client polls/refreshes after a delay.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { wo_number } = await context.params

  const { jobId } = await triggerScript("f/service_billing/pull_qbo_invoices", {
    wo_number,
  })

  return NextResponse.json({ jobId, status: "triggered", wo_number })
}
