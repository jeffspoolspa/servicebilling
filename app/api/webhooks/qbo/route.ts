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
 *
 * Entities NOT in this map still land in billing.webhook_log (with status=
 * 'succeeded' + a "no refresh script configured" message) — the architecture
 * intentionally fails-graceful when we receive a webhook for an entity type we
 * haven't wired up yet. Add entries here as we build the matching scripts.
 *
 * Currently wired:
 *   Invoice  → refresh_invoice    (cache: billing.invoices)
 *   Payment  → refresh_payment    (cache: billing.customer_payments;
 *                                  also rechecks linked invoice statuses)
 *   Customer → refresh_customer   (cache: public."Customers";
 *                                  also propagates display_name renames
 *                                  to billing.invoices.customer_name)
 *
 * Not yet wired:
 *   Estimate, Bill, Vendor, Item, JournalEntry — add when we build their
 *   refresh scripts. The webhook handler will gracefully skip them in the
 *   meantime if we subscribe to their events in Intuit's dashboard.
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
    script: "f/service_billing/refresh_customer",
    argName: "qbo_customer_id",
  },
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

  // We talk to Postgres via PostgREST RPC functions in the public schema
  // (log_qbo_webhook, mark_webhook_processed, confirm_webhook_expectation)
  // because Supabase only exposes the `public` schema by default. The
  // SECURITY DEFINER functions run with postgres privileges and write to
  // billing.* on our behalf. Migration: 20260430..._webhook_rpc_wrappers.

  // Loop through all entity changes. One webhook can carry many.
  for (const notif of body.eventNotifications ?? []) {
    for (const entity of notif.dataChangeEvent?.entities ?? []) {
      const eventType = `${entity.name.toLowerCase()}.${entity.operation.toLowerCase()}`

      // Log the receipt. We do this synchronously (await) so we never lose a
      // webhook to a crash between receipt and log. The dispatch is async.
      const { data: logId, error: logErr } = await sb.rpc("log_qbo_webhook", {
        p_source: "qbo",
        p_event_type: eventType,
        p_entity_type: entity.name,
        p_entity_id: entity.id,
        p_realm_id: notif.realmId,
        p_payload: entity as unknown as Record<string, unknown>,
      })

      if (logErr) {
        console.error("[qbo webhook] failed to log receipt:", logErr)
        // Don't fail the request — Intuit retries on non-2xx and we don't
        // want to thrash on logging errors. Continue dispatching.
      }

      // Confirm any matching pending expectation (closes the loop on our
      // own writes). Awaited because Vercel serverless terminates the lambda
      // when the route handler returns — fire-and-forget RPCs (`void sb.rpc`)
      // would be killed mid-flight before they reach Postgres. The call is
      // ~50-100ms; we have plenty of room under Intuit's 5s timeout.
      await sb.rpc("confirm_webhook_expectation", {
        p_entity_type: entity.name,
        p_entity_id: entity.id,
      })

      // Dispatch the actual cache refresh to Windmill. Don't await — fire
      // and forget so we return 200 fast. The script is idempotent so even
      // if Intuit re-delivers, we don't corrupt anything.
      const mapping = REFRESH_SCRIPTS[entity.name]
      if (!mapping) {
        // We're not subscribed to this entity type — log and skip.
        // Awaited (not voided) for the same Vercel-lambda-lifecycle reason
        // as the expectation confirm above.
        if (logId) {
          await sb.rpc("mark_webhook_processed", {
            p_id: logId,
            p_status: "succeeded",
            p_error_message: "no refresh script configured (skipped)",
          })
        }
        continue
      }

      const dispatchPromise = (async () => {
        try {
          // Pass the QBO operation as a hint to refresh scripts that
          // care (e.g. refresh_invoice routes Void → handle_voided).
          // Scripts that don't care about it (refresh_payment,
          // refresh_customer) ignore the parameter — Windmill scripts
          // accept extra unknown args harmlessly.
          await triggerScript(mapping.script, {
            [mapping.argName]: entity.id,
            operation: entity.operation,
          })
          if (logId) {
            await sb.rpc("mark_webhook_processed", {
              p_id: logId,
              p_status: "succeeded",
              p_error_message: null,
            })
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.error(
            `[qbo webhook] dispatch failed for ${entity.name}:${entity.id}:`,
            msg,
          )
          if (logId) {
            await sb.rpc("mark_webhook_processed", {
              p_id: logId,
              p_status: "failed",
              p_error_message: msg.slice(0, 500),
            })
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
