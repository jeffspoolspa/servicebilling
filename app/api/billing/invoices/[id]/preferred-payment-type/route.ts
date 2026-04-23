import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"

/**
 * POST /api/billing/invoices/[id]/preferred-payment-type
 * Body: { type: "card" | "ach" | null }
 *
 * Per-invoice override for which payment-method type to charge. Honored by
 * process_invoice.get_active_payment_method — when a default of the given
 * type exists, it wins over the "most recently added default" fallback.
 * Pass null to clear the override.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  let type: "card" | "ach" | null
  try {
    const body = await request.json()
    const t = body?.type
    if (t === "card" || t === "ach") {
      type = t
    } else if (t === null) {
      type = null
    } else {
      return NextResponse.json(
        { error: "type must be 'card', 'ach', or null" },
        { status: 400 },
      )
    }
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const sb = createAnon("public")
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
