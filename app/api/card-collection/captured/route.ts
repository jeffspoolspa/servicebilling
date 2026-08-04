import { NextResponse, type NextRequest } from "next/server"
import { triggerScript } from "@/lib/windmill"

/**
 * POST /api/card-collection/captured — the vault tells us a payment method was
 * saved; converge our cached wallet for that customer.
 *
 * Module: docs/flows/card-on-file-collection/index.md
 * Auth: service-token (Bearer VAULT_SECRET_KEY — the shared secret we already
 *       hold to mint sessions, reused here so the vault needs no new config)
 *
 * External APIs:
 *   - Windmill: f/service_billing/pull_customer_payment_methods (only_customer_id)
 *
 * Triggered by:
 *   - card-vault `capture` edge function, after the card is vaulted in QBO
 *
 * Why this exists:
 *   Without it, a card lands in QBO and billing.customer_payment_methods stays
 *   empty — the customer sees "You're all set" while the office sees "No payment
 *   methods on file". The daily sweep picks customers by joining
 *   billing.invoices, so a customer with no open invoice is never swept at all.
 *   (Observed live: T. McTest, QBO 7657.)
 *
 *   The vault used to call the Windmill billing script directly, by path. That
 *   made a payments service carry a billing vocabulary it has no business
 *   knowing. Now it posts a generic "a method was captured" event to one
 *   configured URL, and WHICH cache that invalidates is decided here.
 *
 *   Fired from the vault rather than from the /collect page because the page is
 *   the browser: a customer closing the tab on the success screen would skip it.
 */

export async function POST(req: NextRequest) {
  const secret = process.env.VAULT_SECRET_KEY
  if (!secret) return NextResponse.json({ error: "Not configured" }, { status: 503 })
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as { qbo_customer_id?: unknown }
  const qboCustomerId = String(body.qbo_customer_id ?? "").trim()
  if (!qboCustomerId) {
    return NextResponse.json({ error: "qbo_customer_id is required" }, { status: 400 })
  }

  try {
    // Fire-and-forget: the card is already safe in QBO by the time we hear about
    // it, so a slow refresh must not make the vault's response slow, and a failed
    // one must not read as a failed capture. The cache also self-heals on the
    // next invoice pre-process.
    const { jobId } = await triggerScript("f/service_billing/pull_customer_payment_methods", {
      only_customer_id: qboCustomerId,
    })
    return NextResponse.json({ ok: true, job_id: jobId })
  } catch (e) {
    console.error("card-collection/captured: wallet refresh failed", e)
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "refresh failed" },
      { status: 502 },
    )
  }
}
