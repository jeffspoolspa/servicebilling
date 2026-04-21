import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"

/**
 * POST /api/billing/invoices/[id]/edit
 * Body: { qbo_class?, payment_method?, memo?, statement_memo? }
 *
 * Updates user-editable classification fields while invoice is in needs_review
 * or awaiting_pre_processing. Null/undefined fields are preserved (COALESCE).
 * SECURITY DEFINER RPC enforces state + enum checks.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let body: {
    qbo_class?: string
    payment_method?: string
    memo?: string
    statement_memo?: string
  } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const sb = createAnon("public")
  const { data, error } = await sb.rpc("update_invoice_classification", {
    p_qbo_invoice_id: id,
    p_qbo_class: body.qbo_class ?? null,
    p_payment_method: body.payment_method ?? null,
    p_memo: body.memo ?? null,
    p_statement_memo: body.statement_memo ?? null,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  if (!data) {
    return NextResponse.json({ error: "invoice not found" }, { status: 404 })
  }
  return NextResponse.json({ status: "updated", qbo_invoice_id: id })
}
