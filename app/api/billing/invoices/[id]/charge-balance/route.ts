import { NextResponse, type NextRequest } from "next/server"
import { triggerScriptSync } from "@/lib/windmill"
import { guardApi } from "@/lib/auth/api"
import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * POST /api/billing/invoices/[id]/charge-balance
 * Body: { target_payment_method_id: uuid, channel: "credit_card" | "ach" }
 *
 * Charges the open balance on a previously-processed invoice (or any
 * invoice with balance > 0) to a specific card on file. Creates a new
 * processing_attempts row via the standard process_invoice flow, so the
 * audit trail is identical to a normal first-time charge.
 *
 * Steps:
 *   1. Stamp the invoice with the requested target PM + channel +
 *      preferred_payment_type_overridden_at = now() (so the customer-
 *      level cascade doesn't undo our choice). The BEFORE-UPDATE
 *      attempts_unblocked_at trigger also fires, clearing any prior
 *      charge_declined block.
 *   2. Call f/service_billing/process_invoice with force=true. The
 *      script reads the LIVE QBO balance and charges THAT amount, not
 *      the original invoice total — handles partial credits / writes /
 *      refunds correctly.
 *
 * Pre-flight gates (server-side):
 *   - Service write access required
 *   - Invoice must exist
 *   - target_payment_method_id must belong to this invoice's customer
 *     and be is_active=true
 *   - channel must be 'credit_card' or 'ach'
 */

interface Body {
  target_payment_method_id?: string
  channel?: string
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard

  const { id } = await params
  let body: Body = {}
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const targetPmId = body.target_payment_method_id?.trim()
  const channel = body.channel?.trim()
  if (!targetPmId) {
    return NextResponse.json({ error: "target_payment_method_id required" }, { status: 400 })
  }
  if (channel !== "credit_card" && channel !== "ach") {
    return NextResponse.json(
      { error: "channel must be 'credit_card' or 'ach'" },
      { status: 400 },
    )
  }

  const sb = await createSupabaseServer()

  // Verify the invoice exists + target PM belongs to its customer
  const { data: inv } = await sb
    .from("billing_invoices")
    .select("qbo_invoice_id, qbo_customer_id, balance, billing_status")
    .eq("qbo_invoice_id", id)
    .maybeSingle()
  if (!inv) {
    return NextResponse.json({ error: "invoice not found" }, { status: 404 })
  }
  if (Number(inv.balance ?? 0) <= 0) {
    return NextResponse.json(
      { error: "invoice has no open balance to charge" },
      { status: 400 },
    )
  }

  const { data: pm } = await sb
    .from("billing_customer_payment_methods")
    .select("id, type, is_active, qbo_customer_id")
    .eq("id", targetPmId)
    .maybeSingle()
  if (!pm) {
    return NextResponse.json({ error: "payment method not found" }, { status: 404 })
  }
  if (pm.qbo_customer_id !== inv.qbo_customer_id) {
    return NextResponse.json(
      { error: "payment method belongs to a different customer" },
      { status: 400 },
    )
  }
  if (pm.is_active === false) {
    return NextResponse.json({ error: "payment method is inactive" }, { status: 400 })
  }
  if (pm.type !== channel) {
    return NextResponse.json(
      { error: `channel mismatch: PM is ${pm.type}, you sent ${channel}` },
      { status: 400 },
    )
  }

  // 1. Stamp the invoice with the chosen PM. The BEFORE-UPDATE triggers
  //    on (payment_method, target_payment_method_id, preferred_payment_type)
  //    fire automatically — they stamp attempts_unblocked_at (clears any
  //    prior charge_declined) and trigger payment_method_ok recompute.
  //    We also set preferred_payment_type_overridden_at explicitly so the
  //    customer-cascade RPC + cpm-change auto-resolve trigger leave this
  //    choice alone.
  const { error: updErr } = await sb
    .from("billing_invoices")
    .update({
      payment_method:           "on_file",
      target_payment_method_id: targetPmId,
      preferred_payment_type:   channel,
      preferred_payment_type_overridden_at: new Date().toISOString(),
    })
    .eq("qbo_invoice_id", id)
  if (updErr) {
    return NextResponse.json(
      { error: `failed to set target PM: ${updErr.message}` },
      { status: 500 },
    )
  }

  // 2. Call process_invoice with force=true to bypass the
  //    "billing_status='ready_to_process' required" gate. The script
  //    reads the live QBO balance (not the original invoice total) and
  //    charges THAT amount, which handles partial credits / past
  //    payments correctly.
  try {
    const result = await triggerScriptSync<{
      status?: string
      attempt_id?: string
      charge_id?: string
      qbo_payment_id?: string
      error?: string
    }>(
      "f/service_billing/process_invoice",
      {
        qbo_invoice_id: id,
        force: true,
      },
      { timeoutMs: 60_000 },
    )

    if (result.status !== "succeeded" && result.status !== "ok") {
      return NextResponse.json(
        { error: result.error ?? "charge failed", details: result },
        { status: 502 },
      )
    }

    return NextResponse.json({
      status: "ok",
      attempt_id: result.attempt_id,
      charge_id: result.charge_id,
      qbo_payment_id: result.qbo_payment_id,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
