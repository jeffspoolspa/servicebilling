import { NextResponse, type NextRequest } from "next/server"
import { triggerScript } from "@/lib/windmill"

/**
 * POST /api/billing/invoices/[id]/apply-credit
 * Body: { credit_id: string, amount?: number }
 *
 * Fires f/service_billing/apply_credit_manual which:
 *   1. Calls QBO to link this credit to the invoice (Payment with LinkedTxn)
 *   2. Decrements billing.open_credits.unapplied_amt locally
 *   3. Chains into pre_process_invoice so state refreshes
 *
 * Returns the Windmill jobId immediately (async).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let body: { credit_id?: string; amount?: number } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!body.credit_id) {
    return NextResponse.json({ error: "credit_id required" }, { status: 400 })
  }

  const args: Record<string, unknown> = {
    qbo_invoice_id: id,
    credit_id: body.credit_id,
  }
  if (typeof body.amount === "number") args.amount = body.amount

  const { jobId } = await triggerScript("f/service_billing/apply_credit_manual", args)
  return NextResponse.json({ jobId, status: "triggered" })
}
