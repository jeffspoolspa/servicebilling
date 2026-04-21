import { NextResponse, type NextRequest } from "next/server"
import { triggerScript } from "@/lib/windmill"

/**
 * POST /api/billing/pre-process
 * Body: { qbo_invoice_id: string, force?: boolean }
 *
 * Triggers f/service_billing/pre_process_invoice for a single invoice.
 * Returns the Windmill jobId immediately (async).
 */
export async function POST(request: NextRequest) {
  const body = await request.json()
  const { qbo_invoice_id, force = false } = body

  if (!qbo_invoice_id) {
    return NextResponse.json(
      { error: "Provide qbo_invoice_id" },
      { status: 400 },
    )
  }

  const { jobId } = await triggerScript("f/service_billing/pre_process_invoice", {
    qbo_invoice_id,
    force,
  })

  return NextResponse.json({ jobId, status: "triggered" })
}
