import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { guardApi } from "@/lib/auth/api"

/**
 * POST /api/customers/[id]/preferred-payment-type
 * Body: { type: "email" | "ach" | "credit_card" | null,
 *         applyToNeedsReview?: boolean (default true) }
 *
 * Sets the customer-level payment preference (public."Customers".preferred_payment_type).
 * Optionally cascades to that customer's needs_review invoices, skipping
 * any with an explicit per-invoice override (preferred_payment_type_overridden_at NOT NULL).
 *
 * Future invoices going through pre_process_invoice automatically inherit
 * the new pref via billing.resolve_preferred_payment_type — no separate
 * cascade needed for awaiting_pre_processing rows.
 *
 * The id parameter is the QBO customer id, NOT the local Customers.id.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const { id: qboCustomerId } = await params

  let type: "email" | "ach" | "credit_card" | null
  let applyToNeedsReview = true
  try {
    const body = await request.json()
    const t = body?.type
    if (t === "email" || t === "ach" || t === "credit_card") {
      type = t
    } else if (t === null) {
      type = null
    } else {
      return NextResponse.json(
        { error: "type must be 'email', 'ach', 'credit_card', or null" },
        { status: 400 },
      )
    }
    if (typeof body?.applyToNeedsReview === "boolean") {
      applyToNeedsReview = body.applyToNeedsReview
    }
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  // Session-aware client: forwards the signed-in user's JWT so the RPC's
  // _assert_app_role('service','admin') sees auth.uid() (the anon client has
  // no user identity → "permission denied: not authenticated").
  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("set_customer_preferred_payment_type", {
    p_qbo_customer_id: qboCustomerId,
    p_type: type,
    p_apply_to_needs_review: applyToNeedsReview,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({
    status: "ok",
    ...(data as Record<string, unknown>),
  })
}
