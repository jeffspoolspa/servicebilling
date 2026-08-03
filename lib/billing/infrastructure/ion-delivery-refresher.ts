/**
 * DeliveryRefresher over the Ion object.
 *
 * Re-reads one day at a time. A month-wide pull is ~31 sequential ION
 * scrapes, which exceeds the synchronous job gateway's patience (a real 504,
 * seen 2026-08-03) — and it is unnecessary, because a dispute names tasks and
 * we already know which days they were served on.
 */

import type { DeliveryRefresher } from "@/lib/billing/domain"
import type { IonVisits } from "@/lib/external/ion/ion"

export class IonDeliveryRefresher implements DeliveryRefresher {
  constructor(private readonly visits: IonVisits) {}

  async refreshDays(dates: readonly string[]): Promise<{ visitsTouched: number }> {
    let touched = 0
    for (const day of [...new Set(dates)].sort()) {
      const pull = await this.visits.refreshDays(day, day)
      touched += Math.max(0, pull.visitsTouched)
    }
    return { visitsTouched: touched }
  }
}
