import { NextResponse, type NextRequest } from "next/server"
import { triggerScriptSync } from "@/lib/windmill"
import { guardApi } from "@/lib/auth/api"
import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * POST /api/billing/invoices/[id]/send
 *
 * Deliver the invoice — the human move for the two states that sit in
 * needs_review with nothing left for the engine to decide:
 *   - settled but never emailed (a credit paid it during pre-processing) —
 *     send the paid copy and it derives to `paid`.
 *   - the card declined — the customer pays it themselves now, so the route
 *     switches to email BEFORE the send (otherwise process_one's step()
 *     picks "charge" again and re-runs the dead card) and it derives to
 *     `open_ar`.
 *
 * No new engine: f/service_billing/process_one already sends whatever is
 * unsent (step() -> "send" when settled, or when the route is email), bumps
 * a past-due date, emits invoice_emailed and echoes the mirror.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const { id } = await params

  const sb = await createSupabaseServer()
  const { data: inv } = await sb
    .from("billing_invoices")
    .select("qbo_invoice_id, balance, email_status")
    .eq("qbo_invoice_id", id)
    .maybeSingle()
  if (!inv) return NextResponse.json({ error: "invoice not found" }, { status: 404 })
  if (inv.email_status === "EmailSent") {
    return NextResponse.json({ error: "invoice already sent" }, { status: 400 })
  }

  // Open balance => the customer pays this one themselves. Flip the route
  // first so the send is a send, not another charge.
  const switchedToEmail = Number(inv.balance ?? 0) > 0
  if (switchedToEmail) {
    const { error } = await sb.rpc("set_preferred_payment_type", {
      p_qbo_invoice_id: id,
      p_type: "email",
    })
    if (error) {
      return NextResponse.json(
        { error: `failed to switch to the email route: ${error.message}` },
        { status: 400 },
      )
    }
  }

  try {
    const result = await triggerScriptSync<{ status?: string; send?: { error?: string }; reason?: string }>(
      "f/service_billing/process_one",
      { qbo_invoice_id: id, force: true },
      { timeoutMs: 60_000 },
    )
    if (result.status !== "succeeded" && result.status !== "ok") {
      return NextResponse.json(
        { error: result.send?.error ?? result.reason ?? "send failed", details: result },
        { status: 502 },
      )
    }
    return NextResponse.json({ status: "ok", switched_to_email: switchedToEmail })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    )
  }
}
