/**
 * What the system of record billed, per TASK — reconcile's other side.
 *
 * Today that is the existing `billable_items` ledger, which ION's invoices
 * were built from. When we build invoices ourselves this adapter is swapped
 * for one that reads QBO, and nothing above it changes: that is what the port
 * is for (the model doc's deferred self-build decision).
 */

import type { IonInvoiceFacts } from "@/lib/billing/domain"

interface Db {
  schema(s: string): { from(t: string): Record<string, (...a: never[]) => unknown> }
}

export class SupabaseIonInvoiceFacts implements IonInvoiceFacts {
  constructor(private readonly client: Db) {}

  async perTaskTotals(customerId: number, month: string): Promise<{ taskId: string; totalCents: number }[]> {
    const q = this.client.schema("billing").from("billing_months") as unknown as {
      select(c: string): { eq(c2: string, v: unknown): { eq(c3: string, v3: unknown): { limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } } }
    }
    const { data: monthRows, error } = await q.select("id").eq("customer_id", customerId).eq("month", month).limit(1)
    if (error) throw new Error(`month lookup failed: ${JSON.stringify(error).slice(0, 200)}`)
    const monthId = ((monthRows ?? [])[0] as { id: string } | undefined)?.id
    if (!monthId) return []

    const iq = this.client.schema("billing").from("billable_items") as unknown as {
      select(c: string): { eq(c2: string, v: unknown): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
    }
    const { data, error: iErr } = await iq.select("task_id, amount_cents").eq("billing_month_id", monthId).range(0, 4999)
    if (iErr) throw new Error(`billable_items read failed: ${JSON.stringify(iErr).slice(0, 200)}`)

    const totals = new Map<string, number>()
    for (const r of (data ?? []) as { task_id: string | null; amount_cents: number | null }[]) {
      if (!r.task_id) continue
      totals.set(r.task_id, (totals.get(r.task_id) ?? 0) + (r.amount_cents ?? 0))
    }
    return [...totals].map(([taskId, totalCents]) => ({ taskId, totalCents }))
  }
}
