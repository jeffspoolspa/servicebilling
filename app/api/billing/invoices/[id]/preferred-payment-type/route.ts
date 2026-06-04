import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

/**
 * POST /api/billing/invoices/[id]/preferred-payment-type
 * Body: { type: "email" | "ach" | "credit_card" | null }   (legacy "card" also accepted)
 *
 * Per-invoice override for the payment channel. Updates
 * invoices.preferred_payment_type AND re-picks invoices.target_payment_method_id
 * so process_invoice charges the right PM (it doesn't re-pick at charge time).
 * Pass null to clear the override (next pre_process_invoice run will re-derive
 * from the customer-level rules).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const { id } = await params

  let type: "email" | "ach" | "credit_card" | "card" | null
  try {
    const body = await request.json()
    const t = body?.type
    if (t === "email" || t === "ach" || t === "credit_card" || t === "card") {
      type = t
    } else if (t === null) {
      type = null
    } else {
      return NextResponse.json(
        { error: "type must be 'email', 'ach', 'credit_card', or null" },
        { status: 400 },
      )
    }
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  // Session-aware client so the RPC's _assert_app_role sees the signed-in user.
  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("set_preferred_payment_type", {
    p_qbo_invoice_id: id,
    p_type: type,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  if (!data) {
    return NextResponse.json({ error: "invoice not found" }, { status: 404 })
  }
  return NextResponse.json({
    status: "ok",
    qbo_invoice_id: id,
    preferred_payment_type: type,
  })
}
