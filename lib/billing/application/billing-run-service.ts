/**
 * BillingRunService — starting a month is just enqueueing its commands.
 *
 * The batch is an enqueue LOOP, not a batch operation: each customer-month is
 * its own unit of work, retry and visibility, so one customer's dispute never
 * stalls the other 488. Re-running startMonth is safe — the queue's partial
 * unique index collapses duplicate signals, and every command re-derives from
 * state at claim time.
 */

import type { BillingMonthRepository } from "@/lib/billing/domain"

export interface QueueWriter {
  /** Insert coalesced commands; returns how many were NEW rows. */
  enqueue(monthIds: readonly string[], priority?: number): Promise<{ enqueued: number; coalesced: number }>
}

export class BillingRunService {
  constructor(
    private readonly months: BillingMonthRepository,
    private readonly queue: QueueWriter,
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

  /** One month, at interactive priority — the button, and the detector. */
  async nudge(monthId: string): Promise<void> {
    await this.queue.enqueue([monthId], 1)
  }
}
