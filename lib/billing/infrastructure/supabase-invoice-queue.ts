/**
 * The AdvanceInvoice queue over billing.invoice_queue — the month queue's
 * exact shape at the invoice grain. Coalescing and SKIP LOCKED claiming
 * live in SQL because they are concurrency facts.
 */

interface Db {
  schema(s: string): {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
  }
}

export class SupabaseInvoiceQueue {
  constructor(private readonly client: Db) {}

  async enqueue(invoiceIds: readonly string[], priority = 3): Promise<{ enqueued: number; coalesced: number }> {
    if (invoiceIds.length === 0) return { enqueued: 0, coalesced: 0 }
    const { data, error } = await this.client.schema("billing").rpc("enqueue_invoices", {
      p_invoice_ids: invoiceIds,
      p_priority: priority,
    })
    if (error) throw new Error(`invoice enqueue failed: ${JSON.stringify(error).slice(0, 200)}`)
    const n = Number(data ?? 0)
    return { enqueued: n, coalesced: invoiceIds.length - n }
  }

  async claim(): Promise<{ queueId: number; qboInvoiceId: string; attempts: number } | null> {
    const { data, error } = await this.client.schema("billing").rpc("claim_invoice", {})
    if (error) throw new Error(`invoice claim failed: ${JSON.stringify(error).slice(0, 200)}`)
    const row = (Array.isArray(data) ? data[0] : data) as { queue_id: number; qbo_invoice_id: string; attempts: number } | null
    return row ? { queueId: row.queue_id, qboInvoiceId: row.qbo_invoice_id, attempts: row.attempts } : null
  }

  async finish(queueId: number, error?: string): Promise<void> {
    const { error: e } = await this.client.schema("billing").rpc("finish_invoice", {
      p_queue_id: queueId,
      p_error: error ?? null,
    })
    if (e) throw new Error(`invoice finish failed: ${JSON.stringify(e).slice(0, 200)}`)
  }
}
