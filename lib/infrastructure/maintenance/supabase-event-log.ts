/**
 * The maintenance event stream's write side (ADR 010).
 *
 * Facts go in through maintenance.append_event and nowhere else, so the
 * envelope stays honest and the table's INSERT-only trigger is never argued
 * with. The aggregate names itself as a participant inside the function.
 *
 * What belongs here: things we PROVED happened — a schedule ION accepted, a
 * task we created. What does not: intentions, attempts, or refusals. A write
 * that was refused changed nothing, so it is not a fact about the business;
 * it is a log line. Reads verify, diffs testify.
 */

import type { QueryClient } from "@/lib/infrastructure/routing/supabase-quota-repository"

export interface MaintenanceFact {
  aggregate: "task" | "schedule"
  aggregateId: string
  /** Past tense, permanent vocabulary. */
  type: string
  payload?: Record<string, unknown>
  actor?: string
  /** Durable identities this fact names, e.g. "customer:1234", "tech:<uuid>". */
  participants?: string[]
  occurredAt?: string
}

/** An RPC-capable client — the append function is the only write path. */
type RpcClient = QueryClient & {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}

export class SupabaseMaintenanceEventLog {
  constructor(private readonly client: RpcClient) {}

  /**
   * Append facts, oldest first. Failure to record history must NOT undo the
   * thing that happened — the write to ION already landed and pretending
   * otherwise would be a worse lie than a missing fact. So this reports what
   * it could not append rather than throwing.
   */
  async append(facts: readonly MaintenanceFact[]): Promise<{ written: number; failed: string[] }> {
    const failed: string[] = []
    let written = 0
    for (const f of facts) {
      const { error } = await this.client.rpc("append_event", {
        p_aggregate: f.aggregate,
        p_aggregate_id: f.aggregateId,
        p_type: f.type,
        p_payload: f.payload ?? {},
        p_actor: f.actor ?? "auto",
        p_participants: f.participants ?? [],
        ...(f.occurredAt ? { p_occurred_at: f.occurredAt } : {}),
      })
      if (error) failed.push(`${f.type} ${f.aggregateId}: ${JSON.stringify(error).slice(0, 120)}`)
      else written++
    }
    return { written, failed }
  }
}
