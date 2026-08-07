/**
 * What the billing domain needs implemented, in ITS OWN words.
 *
 * Note what is absent: no Visit aggregate, no Task aggregate, no QBO type.
 * Billing consumes delivery FACTS and agreement TERMS through narrow
 * contracts (Customer/Supplier with a published language), which is what
 * keeps maintenance free to change its model without breaking the money.
 */

import type { BillableSource } from "./billable-item"
import type { BillingMonth } from "./billing-month"
import type { PricingTerms, CatalogPrice } from "./pricer"

export interface BillingMonthRepository {
  byId(monthId: string): Promise<BillingMonth | null>
  forCustomerMonth(customerId: number, month: string): Promise<BillingMonth | null>
  /** Open one if it does not exist yet — accrual's first move. */
  openFor(customerId: number, month: string): Promise<BillingMonth>
  /** Persist items, state and the facts it recorded, in one breath. */
  save(month: BillingMonth): Promise<void>
  /** Customers with delivery in this month — what a run enqueues. */
  customersWithDelivery(month: string): Promise<number[]>
  /**
   * RULED 2026-08-07: an ION billing-type disagreement never holds or
   * refuses — the majority is picked and the disagreement is ONE blocking
   * finding (rule billing_type_conflict) a person reviews or settles by
   * choosing. Sync = raise when conflicted, retract when decided/agreeing;
   * returns whether an open flag remains.
   */
  syncBillingTypeConflict(monthId: string, customerId: number, conflicts: readonly string[], at: string): Promise<boolean>
}

/** What happened at the pool, as facts. Delivery's published language. */
export interface DeliveryFacts {
  sourcesFor(customerId: number, month: string): Promise<BillableSource[]>
}

/**
 * Go and re-read delivery from the system of record.
 *
 * This is the healing half of a dispute: a mismatch is usually not a wrong
 * number but a stale copy, so the month spends its one repull here before
 * anything is called an issue.
 */
export interface DeliveryRefresher {
  /**
   * Re-read this customer's month of delivery, scoped to exactly the logs we
   * already hold. A dispute names tasks; the visits carry their log ids; so
   * the refresh is as small as the question. What this cannot do is discover
   * logs we have NEVER seen — that is the day ingest's job, and a difference
   * caused by one still surfaces to a person after the one repull.
   */
  refreshCustomerMonth(customerId: number, month: string): Promise<{ visitsTouched: number }>
}

/**
 * What the customer agreed to pay. Agreements' published language.
 *
 * `asOf` is the accrual date, not the month: terms change, and accrual prices
 * at what is in force WHEN IT RUNS (Carter's ruling), frozen at invoice
 * creation. Passing it explicitly is what makes a past month re-accruable —
 * "why did SJC pay $600 in June" has an answer only if we can ask the terms
 * as they stood.
 */
export interface AgreementTermsSource {
  termsFor(customerId: number, month: string, asOf: string): Promise<PricingTerms[]>
}

export interface ConsumableCatalog {
  prices(): Promise<CatalogPrice[]>
}

/**
 * What the system of record says it billed, per task — reconcile's other
 * side, and the reason a reconcile means anything: it must come from a
 * DIFFERENT source than the one we priced from, or two calculations over one
 * input can only ever agree.
 */
export interface IonInvoiceFacts {
  perTaskTotals(customerId: number, month: string): Promise<{ taskId: string; totalCents: number }[]>
  /** When that side was last read. A reconcile against a stale report is worth nothing. */
  pulledAt(month: string): Promise<string | null>
  /** Go and read it again. */
  refresh(month: string): Promise<{ pulledAt: string }>
}

export interface IssuedInvoice {
  readonly qboInvoiceId: string
  readonly docNumber: string
  readonly totalCents: number
}

/**
 * Builds the document. Today QBO fills this; the model doc's deferred
 * decision is that someday we fill it and ION is display-only — which is why
 * it is a port and not a method.
 */
export interface InvoiceBuilder {
  build(month: BillingMonth): Promise<IssuedInvoice[]>
  send(qboInvoiceId: string): Promise<void>
}
