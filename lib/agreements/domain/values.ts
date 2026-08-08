/**
 * Agreements — value objects. The context covers STANDING SERVICE CONTRACTS
 * (today: the ION recurring task) — the things quotas and maintenance
 * billing project from. Work orders are NOT in it; a shared notion, if one
 * ever emerges, earns extraction from evidence, not from a superclass hunt.
 *
 * EXIT TEST (module docstring rule): delete ION tomorrow and everything in
 * this folder must remain coherent. ION appears only as opaque reference
 * ids inside the incarnation ledger.
 */

/** How often the customer must be visited — the REQUIRED pattern, contract
 *  data (Q12). WHICH weekday and WHO goes is routing's, never here. */
export type RequiredPattern =
  | { kind: "weekly"; timesPerWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7 }
  | { kind: "biweekly" }
  | { kind: "monthly" }

export const samePattern = (a: RequiredPattern, b: RequiredPattern): boolean =>
  a.kind === b.kind && (a.kind !== "weekly" || a.timesPerWeek === (b as { timesPerWeek: number }).timesPerWeek)

/** How the agreement charges — decoded axes, never a vendor's enum. */
export interface BillingShape {
  billingType: "flat_rate" | "per_visit" | "do_not_invoice"
  invoiceStyle: "itemized" | "summary"
  consumables: "included" | "separate"
  /** The ONE resolved answer (itemcost ?? catalog), plus its inputs so the
   *  rule is re-derivable forever. */
  priceCents: number | null
  priceInputs: { itemCostCents: number | null; serviceTypeId: string }
  sendConsumables: boolean
}

/** One era of the agreement's commercial terms. Closed by the next version. */
export interface TermsVersion {
  readonly version: number
  readonly pattern: RequiredPattern
  readonly billing: BillingShape
  readonly period: { startsOn: string | null; endsOn: string | null }
  readonly from: string // ISO — when this version took effect (observedAt / decidedAt)
  readonly cause: "opened" | "our_edit" | "ion_side"
}

/**
 * One entry in the EXTERNAL-IDENTITY LEDGER. ION task ids are references,
 * never identity; the ledger records every incarnation and WHY it churned.
 * Terms versions and incarnations churn INDEPENDENTLY in both directions:
 * a day move churns the incarnation but not the terms (placement_change);
 * an ION-side price edit versions the terms inside one incarnation.
 */
export interface IonIncarnation {
  readonly ionTaskId: string
  readonly from: string
  readonly to: string | null // null = current
  readonly cause: "opened" | "terms_change" | "placement_change" | "ion_side" | "unknown_backfill"
}

/** Why the work exists. Billability is NOT decided here — it is a policy
 *  outcome at accrual (BillingMonth composes agreement terms × month policy
 *  × visit facts). basis carries the WHY and the rider cascade. */
export type Basis =
  | { kind: "customer_contract" }
  | { kind: "internal_program"; program: "qc"; riderOf: string | null }

export class AgreementRuleError extends Error {}
