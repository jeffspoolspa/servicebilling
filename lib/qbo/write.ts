import "server-only"
import crypto from "crypto"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { triggerScriptSync } from "@/lib/windmill"

/**
 * Synchronous write-through helper for QBO mutations.
 *
 * The architecture (Pattern D, see CLAUDE.md):
 *   1. Generate idempotency key, persist as a webhook expectation.
 *   2. Mark the cache row as 'pending' so the UI shows the in-flight state.
 *   3. POST to QBO via a Windmill script that returns the updated entity.
 *   4. On 200: upsert cache from the QBO response (the QBO 200 IS the truth
 *      for our own writes — the webhook is just async confirmation).
 *   5. Mark cache 'awaiting_propagation' until the webhook lands.
 *   6. Return the updated entity to the caller (API route, which returns to UI).
 *
 * On any failure: the cache stays consistent because we either:
 *   - Don't update cache (QBO rejected the write — sync_state = 'sync_failed')
 *   - Updated cache from QBO's response (write succeeded — sync_state = 'awaiting_propagation')
 *
 * There is no path where we tell the UI 'success' without QBO having
 * actually accepted the write. There is no path where the cache disagrees
 * with QBO for our own writes (only for external writes, which the webhook
 * handler updates separately).
 *
 * Each entity type needs a corresponding Windmill script that performs the
 * actual QBO PATCH/POST and returns the updated entity. That script is the
 * thin layer that owns the QBO auth and HTTP; this helper is the thin layer
 * that owns the cache state machine.
 */

export type QboEntityType =
  | "invoice"
  | "payment"
  | "customer"
  | "estimate"
  | "bill"

interface WriteResult<T> {
  success: boolean
  entity?: T
  error?: string
  idempotencyKey: string
}

interface WriteOptions {
  /** Webhook grace window (ms). After this, the expectation is flagged 'missing'. */
  webhookGraceMs?: number
  /** Override default Windmill script path. Most callers won't need this. */
  scriptOverride?: string
  /** Override default sync timeout (ms). Default 60s. */
  timeoutMs?: number
}

const DEFAULT_WEBHOOK_GRACE_MS = 5 * 60_000 // 5 min

const ENTITY_CONFIG: Record<
  QboEntityType,
  {
    script: string
    cacheTable: string
    cacheSchema: string
    cacheIdColumn: string
  }
> = {
  invoice: {
    script: "f/service_billing/qbo_invoice_write",
    cacheTable: "invoices",
    cacheSchema: "billing",
    cacheIdColumn: "qbo_invoice_id",
  },
  payment: {
    script: "f/service_billing/qbo_payment_write",
    cacheTable: "customer_payments",
    cacheSchema: "billing",
    cacheIdColumn: "qbo_payment_id",
  },
  customer: {
    script: "f/service_billing/qbo_customer_write",
    cacheTable: "Customers", // public."Customers" — case-sensitive, quoted
    cacheSchema: "public",
    cacheIdColumn: "qbo_customer_id",
  },
  estimate: {
    script: "f/service_billing/qbo_estimate_write",
    cacheTable: "estimates",
    cacheSchema: "public",
    cacheIdColumn: "qbo_estimate_id",
  },
  bill: {
    script: "f/service_billing/qbo_bill_write",
    cacheTable: "bills",
    cacheSchema: "billing",
    cacheIdColumn: "qbo_bill_id",
  },
}

/**
 * Write a change to QBO and synchronize our cache.
 *
 * @param entityType  Which QBO entity (invoice, payment, etc.)
 * @param entityId    QBO id of the entity to update
 * @param changes     Partial QBO entity body — fields to update
 * @param options     Optional overrides
 * @returns           Updated entity from QBO's response, or error details.
 *
 * Usage:
 *   const result = await writeToQbo<Invoice>('invoice', '7583161', {
 *     CustomerMemo: { value: 'New memo text' }
 *   })
 *   if (!result.success) return NextResponse.json({ error: result.error }, { status: 502 })
 *   return NextResponse.json({ ok: true, invoice: result.entity })
 */
export async function writeToQbo<T = unknown>(
  entityType: QboEntityType,
  entityId: string,
  changes: Record<string, unknown>,
  options: WriteOptions = {},
): Promise<WriteResult<T>> {
  const config = ENTITY_CONFIG[entityType]
  if (!config) {
    return {
      success: false,
      error: `unknown entity type: ${entityType}`,
      idempotencyKey: "",
    }
  }

  const idempotencyKey = crypto.randomUUID()
  const sb = createSupabaseAdmin()
  const graceMs = options.webhookGraceMs ?? DEFAULT_WEBHOOK_GRACE_MS

  // Step 1: Mark the cache row 'pending' so the UI sees the in-flight state.
  const { error: pendingErr } = await sb
    .schema(config.cacheSchema as "billing" | "public")
    .from(config.cacheTable)
    .update({
      sync_state: "pending",
      sync_state_changed_at: new Date().toISOString(),
      sync_error: null,
    })
    .eq(config.cacheIdColumn, entityId)
  if (pendingErr) {
    // If we can't even mark pending, something is very wrong with our DB.
    // Don't proceed to QBO — fail loudly.
    return {
      success: false,
      error: `failed to mark cache pending: ${pendingErr.message}`,
      idempotencyKey,
    }
  }

  // Step 2: Insert the webhook expectation. Async-of-fact: if this fails we
  // can still proceed (it's a monitoring concern, not a correctness one).
  void sb
    .schema("billing")
    .from("webhook_expectations")
    .insert({
      entity_type: capitalize(entityType),
      entity_id: entityId,
      expected_by: new Date(Date.now() + graceMs).toISOString(),
      source: "self_initiated",
      idempotency_key: idempotencyKey,
    })

  // Step 3: Call the Windmill script that does the actual QBO write.
  // Script contract:
  //   args: { entity_id, changes, idempotency_key }
  //   returns: { success: true, entity: <updated entity from QBO> }
  //         or { success: false, error: string, status_code?: number }
  let scriptResult: {
    success: boolean
    entity?: T
    error?: string
    status_code?: number
  }
  try {
    scriptResult = await triggerScriptSync(
      options.scriptOverride ?? config.script,
      {
        entity_id: entityId,
        changes,
        idempotency_key: idempotencyKey,
      },
      { timeoutMs: options.timeoutMs ?? 60_000 },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : "windmill error"
    await markSyncFailed(sb, config, entityId, msg)
    return { success: false, error: msg, idempotencyKey }
  }

  if (!scriptResult.success || !scriptResult.entity) {
    const errMsg = scriptResult.error ?? "qbo write failed"
    await markSyncFailed(sb, config, entityId, errMsg)
    return { success: false, error: errMsg, idempotencyKey }
  }

  // Step 4: Cache from QBO's response. The script also does this internally
  // (so the trigger -> webhook -> refresh path works for external writes),
  // but here we additionally flip sync_state to 'awaiting_propagation' to
  // signal the UI that QBO accepted but the webhook hasn't arrived yet.
  await sb
    .schema(config.cacheSchema as "billing" | "public")
    .from(config.cacheTable)
    .update({
      sync_state: "awaiting_propagation",
      sync_state_changed_at: new Date().toISOString(),
      sync_error: null,
    })
    .eq(config.cacheIdColumn, entityId)

  return {
    success: true,
    entity: scriptResult.entity,
    idempotencyKey,
  }
}

async function markSyncFailed(
  sb: ReturnType<typeof createSupabaseAdmin>,
  config: (typeof ENTITY_CONFIG)[QboEntityType],
  entityId: string,
  errorMessage: string,
): Promise<void> {
  await sb
    .schema(config.cacheSchema as "billing" | "public")
    .from(config.cacheTable)
    .update({
      sync_state: "sync_failed",
      sync_state_changed_at: new Date().toISOString(),
      sync_error: errorMessage.slice(0, 500),
    })
    .eq(config.cacheIdColumn, entityId)
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Create a NEW entity in QBO (leader-correct) and link it into our cache.
 *
 * writeToQbo (above) is UPDATE-only — it keys the cache row by an existing QBO id.
 * A brand-new entity has no QBO id yet, so the create path keys the cache row by our
 * LOCAL id (e.g. Customers.id) and only learns the QBO id from the create script's
 * 200 response. Sequence (Pattern D, create variant):
 *   1. Mark the local cache row 'pending' (by localId).
 *   2. Call the Windmill create script -> { success, qbo_id, entity }.
 *   3. On 200: stamp the qbo id + 'awaiting_propagation' on the local row, and write a
 *      billing.webhook_expectations row (now that we know the QBO id).
 *   4. The inbound QBO webhook (refresh_<entity> + confirm_webhook_expectation) reflects
 *      the canonical record and resolves the expectation; CDC reconciler is the backstop.
 *
 * Script contract:
 *   args:    { operation: 'create', body, idempotency_key }
 *   returns: { success: true, qbo_id, entity } | { success: false, error }
 */
export async function createInQbo<T = unknown>(
  entityType: QboEntityType,
  body: Record<string, unknown>,
  opts: WriteOptions & { localId: string | number; localIdColumn?: string },
): Promise<WriteResult<T> & { qboId?: string }> {
  const config = ENTITY_CONFIG[entityType]
  if (!config) {
    return { success: false, error: `unknown entity type: ${entityType}`, idempotencyKey: "" }
  }
  const localIdColumn = opts.localIdColumn ?? "id"
  const idempotencyKey = crypto.randomUUID()
  const sb = createSupabaseAdmin()
  const graceMs = opts.webhookGraceMs ?? DEFAULT_WEBHOOK_GRACE_MS

  // 1. Mark the local cache row pending (keyed by OUR id — no QBO id exists yet).
  await sb
    .schema(config.cacheSchema as "billing" | "public")
    .from(config.cacheTable)
    .update({
      sync_state: "pending",
      sync_state_changed_at: new Date().toISOString(),
      sync_error: null,
    })
    .eq(localIdColumn, opts.localId)

  // 2. Call the Windmill create script.
  let scriptResult: { success: boolean; qbo_id?: string; entity?: T; error?: string }
  try {
    scriptResult = await triggerScriptSync(
      opts.scriptOverride ?? config.script,
      { operation: "create", body, idempotency_key: idempotencyKey },
      { timeoutMs: opts.timeoutMs ?? 60_000 },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : "windmill error"
    await markSyncFailedByLocal(sb, config, localIdColumn, opts.localId, msg)
    return { success: false, error: msg, idempotencyKey }
  }

  if (!scriptResult.success || !scriptResult.qbo_id) {
    const errMsg = scriptResult.error ?? "qbo create failed"
    await markSyncFailedByLocal(sb, config, localIdColumn, opts.localId, errMsg)
    return { success: false, error: errMsg, idempotencyKey }
  }

  // 3. Link the QBO id + flip to awaiting_propagation; write the expectation WAL.
  await sb
    .schema(config.cacheSchema as "billing" | "public")
    .from(config.cacheTable)
    .update({
      [config.cacheIdColumn]: scriptResult.qbo_id,
      sync_state: "awaiting_propagation",
      sync_state_changed_at: new Date().toISOString(),
      sync_error: null,
    })
    .eq(localIdColumn, opts.localId)

  // Write-ahead row: the webhook handler resolves it via confirm_webhook_expectation.
  void sb
    .schema("billing")
    .from("webhook_expectations")
    .insert({
      entity_type: capitalize(entityType),
      entity_id: scriptResult.qbo_id,
      expected_by: new Date(Date.now() + graceMs).toISOString(),
      source: "self_initiated",
      idempotency_key: idempotencyKey,
    })

  return {
    success: true,
    entity: scriptResult.entity,
    qboId: scriptResult.qbo_id,
    idempotencyKey,
  }
}

async function markSyncFailedByLocal(
  sb: ReturnType<typeof createSupabaseAdmin>,
  config: (typeof ENTITY_CONFIG)[QboEntityType],
  localIdColumn: string,
  localId: string | number,
  errorMessage: string,
): Promise<void> {
  await sb
    .schema(config.cacheSchema as "billing" | "public")
    .from(config.cacheTable)
    .update({
      sync_state: "sync_failed",
      sync_state_changed_at: new Date().toISOString(),
      sync_error: errorMessage.slice(0, 500),
    })
    .eq(localIdColumn, localId)
}
