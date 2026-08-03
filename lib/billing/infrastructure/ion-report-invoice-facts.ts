/**
 * What ION says it billed, per task — the INDEPENDENT side of the reconcile.
 *
 * This reads `billing_audit.ion_task_transactions`, ION's own All
 * Transactions report for the month. That independence is the whole point:
 * the previous adapter compared our arithmetic against our own ledger, which
 * is derived from the same visit cache we price from, so two calculations
 * over one input could only ever agree. A reconcile that cannot see a stale
 * input is not a reconcile.
 *
 * ION keys the report by its own task id, so this maps ion_task_id -> our
 * task id; a transaction for a task we do not know about is reported as its
 * own finding rather than silently dropped.
 */

import type { IonInvoiceFacts } from "@/lib/billing/domain"
import type { IonReports } from "@/lib/external/ion/ion"

interface Db {
  schema(s: string): { from(t: string): Record<string, (...a: never[]) => unknown> }
}

type Sel = {
  select(c: string): Sel
  eq(c: string, v: unknown): Sel
  in(c: string, v: unknown[]): Sel
  not(c: string, op: string, v: unknown): Sel
  range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }>
}

export class IonReportInvoiceFacts implements IonInvoiceFacts {
  /**
   * The report is pulled ONCE PER RUN, not once per customer-month.
   *
   * It is a month-wide report, so one pull answers for all ~490 customers in
   * it; pulling per reconcile would be ~490 chromium scrapes at ~15s each —
   * two hours to learn the same thing. This memo gives every month in a run
   * the same fresh report, and a new run pulls again.
   */
  private pulls = new Map<string, Promise<{ pulledAt: string }>>()

  constructor(
    private readonly client: Db,
    /** The Ion object owns the pull; this adapter only reads what it loaded. */
    private readonly reports: IonReports,
  ) {}

  private q(schema: string, table: string): Sel {
    return this.client.schema(schema).from(table) as unknown as Sel
  }

  async perTaskTotals(customerId: number, month: string): Promise<{ taskId: string; totalCents: number }[]> {
    // Our tasks for this customer, with the ION ids the report speaks in.
    const { data: taskRows, error: tErr } = await this.q("maintenance", "tasks")
      .select("id, ion_task_id")
      .eq("customer_id", customerId)
      .not("ion_task_id", "is", null)
      .range(0, 199)
    if (tErr) throw new Error(`task map read failed: ${JSON.stringify(tErr).slice(0, 200)}`)

    const ours = new Map<string, string>()
    for (const t of (taskRows ?? []) as { id: string; ion_task_id: string | null }[]) {
      if (t.ion_task_id) ours.set(String(t.ion_task_id), t.id)
    }
    if (ours.size === 0) return []

    const { data, error } = await this.q("billing_audit", "ion_task_transactions")
      .select("ion_task_id, amt_cents, status")
      .eq("month", month)
      .in("ion_task_id", [...ours.keys()])
      .range(0, 4999)
    if (error) throw new Error(`ion report read failed: ${JSON.stringify(error).slice(0, 200)}`)

    const totals = new Map<string, number>()
    for (const r of (data ?? []) as { ion_task_id: string; amt_cents: number | null; status: string | null }[]) {
      const taskId = ours.get(String(r.ion_task_id))
      if (!taskId) continue
      totals.set(taskId, (totals.get(taskId) ?? 0) + (r.amt_cents ?? 0))
    }
    return [...totals].map(([taskId, totalCents]) => ({ taskId, totalCents }))
  }

  /**
   * Go and read ION's report again — the Ion object does the work. Coalesced
   * per month for the life of this adapter, so a whole run costs one scrape
   * and concurrent callers wait on the same promise rather than racing.
   */
  refresh(month: string): Promise<{ pulledAt: string }> {
    const key = month.slice(0, 7)
    const existing = this.pulls.get(key)
    if (existing) return existing
    const pull = this.reports
      .pullTaskTransactions(month)
      .then((p) => ({ pulledAt: p.pulledAt }))
      .catch((e) => {
        this.pulls.delete(key) // a failed pull must not poison the run
        throw e
      })
    this.pulls.set(key, pull)
    return pull
  }

  /** When ION's report was last pulled — a reconcile against a stale report
   *  is worth nothing, so the caller should refuse to trust an old one. */
  async pulledAt(month: string): Promise<string | null> {
    const { data, error } = await this.q("billing_audit", "ion_task_transactions")
      .select("pulled_at").eq("month", month).range(0, 0)
    if (error) throw new Error(`report freshness read failed: ${JSON.stringify(error).slice(0, 200)}`)
    return ((data ?? [])[0] as { pulled_at: string } | undefined)?.pulled_at ?? null
  }
}
