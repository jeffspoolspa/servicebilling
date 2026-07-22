import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"
import { guardApi } from "@/lib/auth/api"

/**
 * POST /api/billing/invoices/[id]/reject-credit
 * Body: { credit_id: string, note?: string }
 *
 * Rejects one open credit-decision candidate for this invoice
 * (billing.invoice_credit_decisions: candidate -> rejected). The credit
 * itself stays open for other invoices — this only records the decision
 * that it is not applicable HERE.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const { id } = await params

  let body: { credit_id?: string; note?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!body.credit_id) {
    return NextResponse.json({ error: "credit_id required" }, { status: 400 })
  }

  const sb = createAnon("public")
  const { data, error } = await sb.rpc("reject_credit_decision", {
    p_qbo_invoice_id: id,
    p_credit_id: body.credit_id,
    p_note: body.note?.trim() || null,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  if (!data) {
    return NextResponse.json(
      { error: "no open candidate for that credit on this invoice" },
      { status: 404 },
    )
  }
  return NextResponse.json({ status: "rejected", credit_id: body.credit_id })
}
