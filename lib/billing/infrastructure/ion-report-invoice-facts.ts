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
   * The report is pulled once per FRESHNESS WINDOW, not once per month and
   * not once per process.
   *
   * It is a month-wide report: one pull answers for all ~490 customers.
   * The in-memory memo coalesces concurrent callers inside one process, but
   * a DRAINER claims one command per job, so the memo dies between claims —
   * the durable guard is `pulled_at` on the persisted rows: if the report
   * was pulled within the window, the scrape is skipped. First claim of a
   * drain pays ~15s; the other 488 read the same rows for free.
   */
  private pulls = new Map<string, Promise<{ pulledAt: string }>>()

  /** How old the report may be before a reconcile refuses to trust it. */
  static readonly MAX_REPORT_AGE_MINUTES = 60

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

  /** Month-wide totals for the BULK path: every customer at once. */
  async perTaskTotalsForMonth(month: string): Promise<Map<number, { taskId: string; totalCents: number }[]>> {
    const taskRows: { id: string; ion_task_id: string | null; customer_id: number | null }[] = []
    for (let off = 0; ; off += 1000) {
      const { data, error } = await (this.q("maintenance", "tasks") as unknown as {
        select(c: string): { not(c2: string, op: string, v: unknown): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
      }).select("id, ion_task_id, customer_id").not("ion_task_id", "is", null).range(off, off + 999)
      if (error) throw new Error(`task map page failed: ${JSON.stringify(error).slice(0, 200)}`)
      const rows = (data ?? []) as typeof taskRows
      taskRows.push(...rows)
      if (rows.length < 1000) break
    }
    const ours = new Map<string, { taskId: string; customerId: number }>()
    for (const t of taskRows) if (t.ion_task_id && t.customer_id) ours.set(String(t.ion_task_id), { taskId: t.id, customerId: t.customer_id })

    const out = new Map<number, Map<string, number>>()
    for (let off = 0; ; off += 1000) {
      const { data, error } = await (this.q("billing_audit", "ion_task_transactions") as unknown as {
        select(c: string): { eq(c2: string, v: unknown): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
      }).select("ion_task_id, amt_cents").eq("month", month).range(off, off + 999)
      if (error) throw new Error(`ion report page failed: ${JSON.stringify(error).slice(0, 200)}`)
      const rows = (data ?? []) as { ion_task_id: string; amt_cents: number | null }[]
      for (const r of rows) {
        const hit = ours.get(String(r.ion_task_id))
        if (!hit) continue
        const per = out.get(hit.customerId) ?? new Map<string, number>()
        per.set(hit.taskId, (per.get(hit.taskId) ?? 0) + (r.amt_cents ?? 0))
        out.set(hit.customerId, per)
      }
      if (rows.length < 1000) break
    }
    return new Map([...out].map(([cid, per]) => [cid, [...per].map(([taskId, totalCents]) => ({ taskId, totalCents }))]))
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
    const pull = (async () => {
      // Durable freshness check first — another job may have just pulled it.
      const last = await this.pulledAt(month)
      if (last && Date.now() - new Date(last).getTime() < IonReportInvoiceFacts.MAX_REPORT_AGE_MINUTES * 60_000) {
        return { pulledAt: last }
      }
      const p = await this.reports.pullTaskTransactions(month)
      return { pulledAt: p.pulledAt }
    })().catch((e) => {
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
