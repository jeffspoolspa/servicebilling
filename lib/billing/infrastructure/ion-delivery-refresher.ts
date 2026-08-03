/**
 * DeliveryRefresher over the Ion object.
 *
 * A month's dispute buys exactly one of these, so it re-reads the whole
 * month's logs — the cheapest thing that is certainly sufficient, since a
 * difference can come from any day in it.
 */

import type { DeliveryRefresher } from "@/lib/billing/domain"
import type { IonVisits } from "@/lib/external/ion/ion"

export class IonDeliveryRefresher implements DeliveryRefresher {
  constructor(private readonly visits: IonVisits) {}

  async refreshMonth(month: string): Promise<{ visitsTouched: number }> {
    const [y, m] = month.split("-").map(Number)
    const lastDay = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 0)).getUTCDate()
    const pad = (n: number) => String(n).padStart(2, "0")
    const pull = await this.visits.refreshDays(`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(lastDay)}`)
    return { visitsTouched: pull.visitsTouched }
  }
}
