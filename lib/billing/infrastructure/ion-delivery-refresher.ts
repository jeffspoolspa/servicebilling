/**
 * DeliveryRefresher over the Ion object, scoped to the customer's own logs.
 *
 * We hold every visit's ion_log_id, so healing a dispute is one targeted
 * job: prime once, fetch those logs, upsert. Its predecessor re-ingested
 * every customer's logs for whole days — minutes of wall clock and side
 * effects on uninvolved customers, to answer a three-visit question.
 */

import type { DeliveryRefresher } from "@/lib/billing/domain"
import type { IonVisits, LogRef } from "@/lib/external/ion/ion"

interface Db {
  schema(s: string): { from(t: string): Record<string, (...a: never[]) => unknown> }
}

export class IonDeliveryRefresher implements DeliveryRefresher {
  constructor(
    private readonly client: Db,
    private readonly visits: IonVisits,
  ) {}

  async refreshCustomerMonth(customerId: number, month: string): Promise<{ visitsTouched: number }> {
    const [y, m] = month.split("-").map(Number)
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`
    const q = this.client.schema("maintenance").from("visits") as unknown as {
      select(c: string): { eq(c2: string, v: unknown): { gte(c3: string, v3: unknown): { lt(c4: string, v4: unknown): { not(c5: string, op: string, v5: unknown): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } } } } }
    }
    const { data, error } = await q
      .select("ion_log_id, ion_calendar_id")
      .eq("customer_id", customerId)
      .gte("visit_date", `${month.slice(0, 7)}-01`)
      .lt("visit_date", next)
      .not("ion_log_id", "is", null)
      .range(0, 499)
    if (error) throw new Error(`log-ref read failed: ${JSON.stringify(error).slice(0, 200)}`)

    const refs: LogRef[] = ((data ?? []) as { ion_log_id: string; ion_calendar_id: string | null }[]).map((r) => ({
      logId: r.ion_log_id,
      calendarId: r.ion_calendar_id,
    }))
    if (refs.length === 0) return { visitsTouched: 0 }
    const pull = await this.visits.refreshLogs(refs)
    return { visitsTouched: pull.visitsTouched }
  }
}
