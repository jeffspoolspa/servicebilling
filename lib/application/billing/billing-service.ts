/**
 * The application service for Billing — one named method per boundary-crossing
 * use case (docs/conventions/LAYERING.md). Load -> domain -> persist; the
 * decisions are all downstairs.
 */
import { SupabaseBillingRepository } from "@/lib/infrastructure/billing/supabase-billing-repository"

export interface AccrualSummary {
  readonly customerId: number
  readonly month: string
  readonly items: number
  readonly labor: number
  readonly consumables: number
  readonly unpricedItems: number
  readonly expectedTotalCents: number
  readonly removed: number
}

export class BillingService {
  constructor(private readonly repository: SupabaseBillingRepository) {}

  /**
   * The one writer of billable items: set-based, idempotent accrual for one
   * customer-month. When it runs is a freshness knob (ingest wake, sweep,
   * button) — never a correctness question.
   */
  async accrueMonth(customerId: number, month: string): Promise<AccrualSummary> {
    const { month: aggregate, storedId } = await this.repository.monthOf(customerId, month)
    const [{ visits, terms }, catalog] = await Promise.all([
      this.repository.factsFor(customerId, month),
      this.repository.catalog(),
    ])
    const items = aggregate.accrue(visits, terms, catalog)
    const { removed } = await this.repository.saveAccrual(aggregate, storedId)
    const exp = aggregate.expectations()
    return {
      customerId,
      month,
      items: items.length,
      labor: items.filter((i) => i.kind === "labor").length,
      consumables: items.filter((i) => i.kind === "consumable").length,
      unpricedItems: items.filter((i) => i.kind === "consumable" && i.unitPriceCents === null).length,
      expectedTotalCents: exp.reduce((n, e) => n + e.laborCents + e.consumableCents, 0),
      removed,
    }
  }
}
