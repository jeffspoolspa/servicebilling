import { NextResponse, type NextRequest } from "next/server"
import crypto from "crypto"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { triggerScript } from "@/lib/windmill"

/**
 * QBO webhook receiver.
 *
 * Configured in Intuit Developer Portal at:
 *   developer.intuit.com → My Apps → <app> → Webhooks
 *
 * This endpoint is the ONLY place QBO talks to us asynchronously, and it does
 * three jobs in order of priority:
 *
 *   1. VERIFY signature (HMAC-SHA256 with QBO_WEBHOOK_TOKEN). Drop unsigned or
 *      mis-signed requests with 401. This is non-negotiable — without it, anyone
 *      who knows the URL can corrupt our cache.
 *
 *   2. LOG every receipt to billing.webhook_log. This row is our audit trail
 *      and the idempotency anchor: if Intuit re-delivers the same event (which
 *      they will on timeout), we can detect the duplicate.
 *
 *   3. DISPATCH async work to Windmill. The actual cache update (fetching the
 *      entity from QBO and upserting) lives in Windmill scripts where the QBO
 *      auth + DB connections already live. We return 200 fast (<2s) so Intuit
 *      doesn't time out and re-deliver.
 *
 * What we don't do here:
 *   - Fetch the entity from QBO (Windmill does that)
 *   - Update the cache (Windmill does that)
 *   - Reconcile drift (the cdc_reconciler script does that on cron)
 *
 * Architecture note: this endpoint is the cache-update mechanism for EXTERNAL
 * changes only. For our own writes, the synchronous QBO 200 response IS the
 * cache-update signal — see lib/qbo/write.ts. Webhooks for our own writes
 * arrive as confirmation but are not load-bearing for correctness.
 */

interface IntuitEntity {
  name: string // 'Invoice' | 'Payment' | 'Customer' | ...
  id: string
  operation: string // 'Create' | 'Update' | 'Delete' | 'Emailed' | ...
  lastUpdated: string // ISO timestamp
  deletedId?: string
}

interface IntuitNotification {
  realmId: string
  dataChangeEvent: {
    entities: IntuitEntity[]
  }
}

interface IntuitWebhookPayload {
  eventNotifications: IntuitNotification[]
}

function verifySignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false
  const token = process.env.QBO_WEBHOOK_TOKEN
  if (!token) {
    console.error(
      "QBO_WEBHOOK_TOKEN not set — webhook signature verification will fail until it is.",
    )
    return false
  }

  const expected = crypto
    .createHmac("sha256", token)
    .update(rawBody, "utf8")
    .digest("base64")

  // timingSafeEqual to avoid timing attacks; lengths must match first.
  const expectedBuf = Buffer.from(expected)
  const sigBuf = Buffer.from(signature)
  if (expectedBuf.length !== sigBuf.length) return false
  try {
    return crypto.timingSafeEqual(expectedBuf, sigBuf)
  } catch {
    return false
  }
}

/**
 * Map QBO entity name → Windmill script that knows how to refresh that entity
 * type. Each script must accept a single id parameter and be idempotent — they
 * fetch from QBO and upsert into the cache, no side effects on duplicate runs.
 */
const REFRESH_SCRIPTS: Record<string, { script: string; argName: string }> = {
  Invoice: {
    script: "f/service_billing/refresh_invoice",
    argName: "qbo_invoice_id",
  },
  Payment: {
    script: "f/service_billing/refresh_payment",
    argName: "qbo_payment_id",
  },
  Customer: {
    script: "f/service_billing/qbo_customer_sync",
    argName: "qbo_customer_id",
  },
  // Add more as we wire them up:
  //   Estimate, Bill, Vendor, Item, JournalEntry, etc.
}

export async function POST(req: NextRequest) {
  // Read raw body — required because signature verification works on the
  // exact bytes Intuit signed, not on the parsed JSON.
  const rawBody = await req.text()
  const signature = req.headers.get("intuit-signature")

  // Tier 1: signature check. Drop early to keep our log clean of garbage.
  if (!verifySignature(rawBody, signature)) {
    console.warn("[qbo webhook] rejected: bad/missing signature")
    return NextResponse.json(
      { error: "invalid signature" },
      { status: 401 },
    )
  }

  let body: IntuitWebhookPayload
  try {
    body = JSON.parse(rawBody) as IntuitWebhookPayload
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 })
  }

  const sb = createSupabaseAdmin()
  const dispatchPromises: Promise<unknown>[] = []

  // Loop through all entity changes. One webhook can carry many.
  for (const notif of body.eventNotifications ?? []) {
    for (const entity of notif.dataChangeEvent?.entities ?? []) {
      const eventType = `${entity.name.toLowerCase()}.${entity.operation.toLowerCase()}`

      // Log the receipt. We do this synchronously (await) so we never lose a
      // webhook to a crash between receipt and log. The dispatch is async.
      const { data: logRow, error: logErr } = await sb
        .schema("billing")
        .from("webhook_log")
        .insert({
          source: "qbo",
          event_type: eventType,
          entity_type: entity.name,
          entity_id: entity.id,
          realm_id: notif.realmId,
          payload: entity as unknown as Record<string, unknown>,
          status: "received",
        })
        .select()
        .single()

      if (logErr) {
        console.error("[qbo webhook] failed to log receipt:", logErr)
        // Don't fail the request — Intuit retries on non-2xx and we don't
        // want to thrash on logging errors. Continue dispatching.
      }

      // Confirm any matching pending expectation (closes the loop on our
      // own writes). Best-effort — if there's no expectation, this no-ops.
      void sb
        .schema("billing")
        .from("webhook_expectations")
        .update({
          webhook_received_at: new Date().toISOString(),
          status: "confirmed",
        })
        .eq("entity_id", entity.id)
        .eq("entity_type", entity.name)
        .eq("status", "pending")

      // Dispatch the actual cache refresh to Windmill. Don't await — fire
      // and forget so we return 200 fast. The script is idempotent so even
      // if Intuit re-delivers, we don't corrupt anything.
      const mapping = REFRESH_SCRIPTS[entity.name]
      if (!mapping) {
        // We're not subscribed to this entity type — log and skip.
        if (logRow) {
          void sb
            .schema("billing")
            .from("webhook_log")
            .update({
              processed_at: new Date().toISOString(),
              status: "succeeded",
              error_message: "no refresh script configured (skipped)",
            })
            .eq("id", logRow.id)
        }
        continue
      }

      const dispatchPromise = (async () => {
        try {
          await triggerScript(mapping.script, {
            [mapping.argName]: entity.id,
          })
          if (logRow) {
            await sb
              .schema("billing")
              .from("webhook_log")
              .update({
                processed_at: new Date().toISOString(),
                status: "succeeded",
              })
              .eq("id", logRow.id)
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.error(
            `[qbo webhook] dispatch failed for ${entity.name}:${entity.id}:`,
            msg,
          )
          if (logRow) {
            await sb
              .schema("billing")
              .from("webhook_log")
              .update({
                status: "failed",
                error_message: msg.slice(0, 500),
                retry_count: 1,
              })
              .eq("id", logRow.id)
          }
        }
      })()

      dispatchPromises.push(dispatchPromise)
    }
  }

  // Vercel serverless: keep the promises alive after we respond. Without
  // this, the function may be killed before dispatches complete. The new
  // Next.js `after` API or `waitUntil` would be cleaner, but Promise.allSettled
  // works for now since the dispatches are individually fast (just an
  // HTTP POST to Windmill — actual work happens in Windmill).
  void Promise.allSettled(dispatchPromises)

  return NextResponse.json({
    ok: true,
    notifications: body.eventNotifications?.length ?? 0,
  })
}

/**
 * Intuit pings this endpoint with a GET during dashboard validation. Some
 * webhook providers also use HEAD or OPTIONS. We just return 200 to confirm
 * reachability — no signature check needed because there's no payload.
 */
export async function GET() {
  return NextResponse.json({ ok: true, service: "qbo-webhook-receiver" })
}
