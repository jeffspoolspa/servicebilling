/**
 * The AdvanceMonth queue over billing.billing_month_queue.
 *
 * Coalescing is the partial unique index (one OPEN row per month); claiming
 * is FOR UPDATE SKIP LOCKED so concurrent drains never double-claim. Both
 * live in SQL because they are concurrency facts no application memory can
 * enforce.
 */

import type { QueueWriter } from "@/lib/billing/application/billing-run-service"

interface Db {
  schema(s: string): {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
    from(t: string): Record<string, (...a: never[]) => unknown>
  }
}

export class SupabaseBillingQueue implements QueueWriter {
  constructor(private readonly client: Db) {}

  async enqueue(monthIds: readonly string[], priority = 3): Promise<{ enqueued: number; coalesced: number }> {
    const { data, error } = await this.client.schema("billing").rpc("enqueue_billing_months", {
      p_month_ids: monthIds,
      p_priority: priority,
    })
    if (error) throw new Error(`enqueue failed: ${JSON.stringify(error).slice(0, 200)}`)
    const n = Number(data ?? 0)
    return { enqueued: n, coalesced: monthIds.length - n }
  }

  /** Claim one command. Null = the queue is drained. */
  async claim(): Promise<{ queueId: number; monthId: string; attempts: number } | null> {
    const { data, error } = await this.client.schema("billing").rpc("claim_billing_month", {})
    if (error) throw new Error(`claim failed: ${JSON.stringify(error).slice(0, 200)}`)
    const row = (Array.isArray(data) ? data[0] : data) as { queue_id: number; billing_month_id: string; attempts: number } | null
    return row ? { queueId: row.queue_id, monthId: row.billing_month_id, attempts: row.attempts } : null
  }

  /** Close any open commands for months the bulk path just settled. */
  async settle(monthIds: readonly string[]): Promise<number> {
    let n = 0
    for (let i = 0; i < monthIds.length; i += 40) {
      const c = monthIds.slice(i, i + 40)
      const q = this.client.schema("billing") as unknown as {
        from(t: string): { update(v: Record<string, unknown>): { in(col: string, v2: unknown[]): { is(c2: string, v3: null): { select(c3: string): PromiseLike<{ data: unknown[] | null; error: unknown }> } } } }
      }
      const { data, error } = await q.from("billing_month_queue")
        .update({ finished_at: new Date().toISOString() })
        .in("billing_month_id", c).is("finished_at", null).select("id")
      if (error) throw new Error(`settle failed: ${JSON.stringify(error).slice(0, 200)}`)
      n += (data ?? []).length
    }
    return n
  }

  async finish(queueId: number, error?: string): Promise<void> {
    const { error: e } = await this.client.schema("billing").rpc("finish_billing_month", {
      p_queue_id: queueId,
      p_error: error ?? null,
    })
    if (e) throw new Error(`finish failed: ${JSON.stringify(e).slice(0, 200)}`)
  }
}
