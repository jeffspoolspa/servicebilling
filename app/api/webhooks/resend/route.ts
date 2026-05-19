import { NextResponse, type NextRequest } from "next/server"
import { Webhook } from "svix"
import {
  lookupCommunicationByProviderMessageId,
  markDelivered,
  markRead,
  markFailed,
} from "@/lib/comms/server/communications-db"

/**
 * POST /api/webhooks/resend
 *
 * Receives delivery / open / bounce events from Resend and backfills the
 * communications row. Resend uses Svix for webhook signing — the
 * RESEND_WEBHOOK_SECRET env var matches the secret you set when adding the
 * endpoint in the Resend dashboard.
 *
 * Event types we handle:
 *   email.delivered → status='delivered', delivered_at = event.created_at
 *   email.opened    → status='read',      read_at      = event.created_at
 *   email.bounced   → status='failed',    error_message= bounce reason
 *   email.complained→ logs to metadata (no status change yet)
 *
 * Not yet handled (low priority — add when needed):
 *   email.sent, email.delivery_delayed, email.clicked
 *
 * Configure in Resend dashboard at:
 *   resend.com → Webhooks → Add Endpoint → https://internal.jeffspoolspa.com/api/webhooks/resend
 *
 * The webhook URL is the SAME for all your domains — one endpoint receives
 * events from every domain you've added in Resend.
 */

interface ResendEventEnvelope {
  type: string
  created_at: string
  data: {
    email_id?: string
    to?: string[] | string
    from?: string
    subject?: string
    bounce?: { type?: string; subType?: string; message?: string }
    [k: string]: unknown
  }
}

export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: "resend_webhook_secret_not_configured" },
      { status: 500 },
    )
  }

  // Svix expects the raw body for signature verification (any whitespace
  // change would invalidate the signature). Read text, then parse.
  const payload = await request.text()
  const headers = {
    "svix-id": request.headers.get("svix-id") ?? "",
    "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
    "svix-signature": request.headers.get("svix-signature") ?? "",
  }

  let event: ResendEventEnvelope
  try {
    const wh = new Webhook(secret)
    event = wh.verify(payload, headers) as ResendEventEnvelope
  } catch {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 })
  }

  const emailId = event.data?.email_id
  if (!emailId) {
    // Acknowledge but log — some event shapes may not include an email_id;
    // returning 200 keeps Resend from retrying for events we can't action.
    return NextResponse.json({ ok: true, ignored: "no_email_id" })
  }

  const communicationId = await lookupCommunicationByProviderMessageId(
    "email_messages",
    emailId,
  )
  if (!communicationId) {
    // Event arrived for a message we don't have a row for — possible if
    // someone sent via Resend outside this transport, or row was deleted.
    return NextResponse.json({ ok: true, ignored: "no_communication_row" })
  }

  try {
    switch (event.type) {
      case "email.delivered":
        await markDelivered({
          communication_id: communicationId,
          delivered_at: event.created_at,
        })
        break

      case "email.opened":
        await markRead({
          communication_id: communicationId,
          read_at: event.created_at,
        })
        break

      case "email.bounced": {
        const reason =
          event.data.bounce?.message ??
          event.data.bounce?.subType ??
          event.data.bounce?.type ??
          "bounce"
        await markFailed({
          communication_id: communicationId,
          error_message: `bounce:${reason}`,
        })
        break
      }

      case "email.complained":
        // Recipient marked as spam. Don't flip status (the message DID send)
        // but flag in metadata so it's queryable.
        // For now log only; consider a separate complaints table later.
        console.warn(
          `[resend webhook] complaint on communication_id=${communicationId}`,
        )
        break

      // Other event types (email.sent, email.delivery_delayed, email.clicked):
      // acknowledge but no action.
      default:
        break
    }
  } catch (e) {
    // Don't let DB errors retry-storm the webhook — log and 200.
    console.error("[resend webhook] db update failed:", e)
  }

  return NextResponse.json({ ok: true })
}
