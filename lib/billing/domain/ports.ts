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
}

/** What happened at the pool, as facts. Delivery's published language. */
export interface DeliveryFacts {
  sourcesFor(customerId: number, month: string): Promise<BillableSource[]>
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

/** One task's invoice as the system of record built it — reconcile's input. */
export interface IonInvoiceFacts {
  perTaskTotals(customerId: number, month: string): Promise<{ taskId: string; totalCents: number }[]>
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
