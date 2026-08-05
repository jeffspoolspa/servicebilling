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
 *   - Windmill: f/qbo/note_card_on_file (stamps the QBO customer's Notes field)
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

  const body = (await req.json().catch(() => ({}))) as {
    qbo_customer_id?: unknown
    brand?: unknown
    last4?: unknown
    method_type?: unknown
  }
  const qboCustomerId = String(body.qbo_customer_id ?? "").trim()
  if (!qboCustomerId) {
    return NextResponse.json({ error: "qbo_customer_id is required" }, { status: 400 })
  }

  // Two independent consequences of one event, dispatched separately so neither
  // can take the other down. Both are fire-and-forget: the card is already safe
  // in QBO by the time we hear about it, so slow follow-up work must not slow
  // the vault's response, and a failure here must never read as a failed
  // capture. The wallet cache also self-heals on the next invoice pre-process.
  const results = await Promise.allSettled([
    triggerScript("f/service_billing/pull_customer_payment_methods", {
      only_customer_id: qboCustomerId,
    }),
    // The office lives in QuickBooks; a method saved on our form is invisible
    // there until someone opens the Payments tab. This note puts it where they
    // already look. Non-destructive — see the script.
    triggerScript("f/qbo/note_card_on_file", {
      qbo_customer_id: qboCustomerId,
      brand: String(body.brand ?? ""),
      last4: String(body.last4 ?? ""),
      method_type: body.method_type === "ach" ? "ach" : "card",
      commit: true,
    }),
  ])

  const [wallet, note] = results
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`card-collection/captured: ${i === 0 ? "wallet refresh" : "QBO note"} failed`, r.reason)
    }
  })

  // 200 even when a follow-up failed: the vault is reporting a completed
  // capture, not asking permission. A non-2xx would only make it log an error
  // about work that is already done.
  return NextResponse.json({
    ok: true,
    wallet_refresh: wallet.status === "fulfilled" ? wallet.value.jobId : "failed",
    qbo_note: note.status === "fulfilled" ? note.value.jobId : "failed",
  })
}
