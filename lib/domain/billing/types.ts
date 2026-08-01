/**
 * Billing domain — input facts and the billable item.
 *
 * Facts arrive as plain shapes loaded by repositories; the domain never
 * queries. Rules ported from the proven builder
 * (f/billing_audit/build_task_billing_periods.py, May 2026: 473/475 exact
 * against ION) — the replay harness holds us to those numbers.
 */

export interface UsageFact {
  readonly id: string
  readonly ionItemId: string | null
  readonly itemName: string | null
  readonly quantity: number
}

export interface VisitFact {
  readonly id: string
  readonly taskId: string
  readonly customerId: number | null
  /** Labor buckets by scheduled_date (the builder's `days` CTE). */
  readonly scheduledDate: string
  /** Consumables bucket by visit_date; agrees except at month boundaries. */
  readonly visitDate: string | null
  readonly serviceable: boolean
  readonly usages: readonly UsageFact[]
}

export interface TaskTerms {
  readonly id: string
  readonly customerId: number | null
  /** NULL in storage means per_visit (the builder's default). */
  readonly billingMethod: "per_visit" | "flat_rate_monthly"
  readonly perVisitCents: number
  readonly flatMonthlyCents: number
  readonly active: boolean
  readonly startsOn: string | null
  readonly endsOn: string | null
}

/** Priced by ion_item_id — immune to the item_id null-out. */
export type Catalog = ReadonlyMap<string, number | null>

export interface BillableItem {
  /** flat = the month's flat charge; no single visit is its source. */
  readonly sourceKind: "visit" | "usage" | "flat"
  readonly sourceId: string | null
  readonly taskId: string
  readonly kind: "labor" | "consumable"
  readonly serviceDate: string | null
  readonly itemName: string | null
  readonly qty: number
  /** null = no catalog price yet — a worklist row, never a silent 0. */
  readonly unitPriceCents: number | null
  readonly amountCents: number | null
}

/** Per-task rollup in the builder's own arithmetic — what reconcile compares. */
export interface TaskExpectation {
  readonly taskId: string
  readonly billableDays: number
  readonly laborCents: number
  /** round(sum(qty) x unit) per item name — rounded ONCE, like the builder. */
  readonly consumableCents: number
  readonly unpriced: ReadonlyMap<string, number>
}
