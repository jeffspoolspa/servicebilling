/**
 * BillingRunService — starting a month is enqueueing; RUNNING a month is the
 * bulk path.
 *
 * advanceAll: ~10 set-based reads, every month advanced IN MEMORY as far as
 * its own nextStep allows (the domain is pure, so 489 months cost
 * milliseconds), then a handful of batched writes. Months that DISPUTE are
 * handed to the QUEUE, because healing is an external ION call per customer —
 * inherently per-unit work. The queue also remains the door for buttons,
 * retries and dead-letter visibility; the bulk path is the month-end
 * throughput, not a replacement.
 */

import { priceMonth, reconcile, type BillingMonth } from "@/lib/billing/domain"
import type { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import type { SupabaseBillingFacts } from "@/lib/billing/infrastructure/supabase-billing-facts"
import type { IonReportInvoiceFacts } from "@/lib/billing/infrastructure/ion-report-invoice-facts"

export interface QueueWriter {
  /** Insert coalesced commands; returns how many were NEW rows. */
  enqueue(monthIds: readonly string[], priority?: number): Promise<{ enqueued: number; coalesced: number }>
  /** Close open commands for months the bulk path just settled. */
  settle(monthIds: readonly string[]): Promise<number>
}

export interface AdvanceAllOutcome {
  months: number
  tally: Record<string, number>
  disputedQueued: number
  statesWritten: number
  itemsRewritten: number
  factsAppended: number
  seconds: number
}

export class BillingRunService {
  constructor(
    private readonly months: SupabaseBillingMonthRepository,
    private readonly queue: QueueWriter,
    private readonly facts?: SupabaseBillingFacts,
    private readonly systemInvoices?: IonReportInvoiceFacts,
  ) {}

  /** Open (or find) every customer-month with delivery, and enqueue them all. */
  async startMonth(month: string): Promise<{ months: number; enqueued: number; coalesced: number }> {
    const customers = await this.months.customersWithDelivery(month)
    const ids: string[] = []
    for (const customerId of customers) {
      const m = await this.months.openFor(customerId, month)
      ids.push(m.id)
    }
    const q = await this.queue.enqueue(ids)
    return { months: ids.length, ...q }
  }

  /** One month, at interactive priority — the button. */
  async nudge(monthId: string): Promise<void> {
    await this.queue.enqueue([monthId], 1)
  }

  /** The whole month, in memory, in seconds. */
  async advanceAll(month: string, opts: { now?: Date } = {}): Promise<AdvanceAllOutcome> {
    if (!this.facts || !this.systemInvoices) throw new Error("advanceAll needs the facts and report adapters wired")
    const t0 = Date.now()
    const now = opts.now ?? new Date()
    const at = now.toISOString()

    // Everything, up front. The report refresh is the one external call, and
    // its durable freshness window makes it a no-op when recently pulled.
    await this.systemInvoices.refresh(month)
    const [monthsAll, sourcesBy, termsBy, catalog, reportTotals] = await Promise.all([
      this.months.allForMonth(month),
      this.facts.sourcesForMonth(month),
      this.facts.termsForMonth(month, at),
      this.facts.prices(),
      this.systemInvoices.perTaskTotalsForMonth(month),
    ])

    const tally: Record<string, number> = {}
    const bump = (k: string) => (tally[k] = (tally[k] ?? 0) + 1)
    const disputed: string[] = []
    const settled: string[] = []

    for (const m of monthsAll) {
      const sources = sourcesBy.get(m.customerId) ?? []
      // Advance until the month parks: a bounded loop, because nextStep can
      // only move forward or stop.
      for (let pass = 0; pass < 4; pass++) {
        const step = m.nextStep(sources, now)
        if (step === "accrue") {
          const priced = new Set<string>()
          for (const t of termsBy.get(m.customerId) ?? []) {
            const out = priceMonth({ month, terms: t, sources, catalog, at })
            for (const item of out.items) {
              m.claim(item, { claimedByMonthId: null }, at)
              priced.add(`${item.sourceKind}:${item.sourceId}`)
            }
          }
          for (const held of m.billableItems) {
            if (!priced.has(`${held.sourceKind}:${held.sourceId}`)) {
              m.release(held.sourceKind, held.sourceId, at, "source no longer delivered — re-accrued")
            }
          }
          continue
        }
        if (step === "reconcile") {
          const totals = reportTotals.get(m.customerId) ?? []
          const r = reconcile(m, totals)
          if (r.agrees) m.markReconciled(at)
          else m.markDisputed(r.findings.map((f) => `${f.rule}: ${f.message}`), at)
          continue
        }
        // refresh_delivery (external, per-unit) and gate/issue/send (Phase 4)
        // both leave the bulk path here.
        break
      }
      bump(m.status)
      if (m.status === "disputed" && !m.deliveryWasRefreshed) disputed.push(m.id)
      else settled.push(m.id)
    }

    const persisted = await this.months.saveAll(monthsAll)
    const q = disputed.length > 0 ? await this.queue.enqueue(disputed, 2) : { enqueued: 0, coalesced: 0 }
    await this.queue.settle(settled)

    return {
      months: monthsAll.length,
      tally,
      disputedQueued: q.enqueued,
      ...persisted,
      seconds: Math.round((Date.now() - t0) / 1000),
    }
  }
}
