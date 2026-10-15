import { NextResponse } from "next/server"
import { verifyWebhook, decodeWebhook } from "@/lib/external/calendly/calendly"
import { onboardingDb } from "@/lib/onboarding/infrastructure/db"
import { logEvent } from "@/lib/onboarding/infrastructure/events"
import { ingestBooking } from "@/lib/onboarding/application/ingest-booking"

export const maxDuration = 60

/**
 * POST /api/webhooks/calendly — Calendly org webhook (invitee.created,
 * invitee.canceled) -> onboarding candidate + interview.
 *
 * Auth: Calendly-Webhook-Signature HMAC with CALENDLY_WEBHOOK_SIGNING_KEY
 * (the session wall skips /api/webhooks/*). Idempotent; a 5xx makes
 * Calendly retry, so failures return 500 after logging.
 */
export async function POST(req: Request) {
  const raw = await req.text()
  const key = process.env.CALENDLY_WEBHOOK_SIGNING_KEY
  if (!key || !verifyWebhook(raw, req.headers.get("calendly-webhook-signature"), key)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 })
  }
  const fact = decodeWebhook(body)
  if (!fact) return NextResponse.json({ ok: true, ignored: true })

  const db = onboardingDb()
  try {
    const r = await ingestBooking(db, fact)
    return NextResponse.json({ ok: true, ...r })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logEvent(db, { type: `calendly.invitee_${fact.kind}`, status: "error", payload: { invitee: fact.inviteeUri }, error: message, actor: "calendly" })
    return NextResponse.json({ error: "ingest failed" }, { status: 500 })
  }
}
