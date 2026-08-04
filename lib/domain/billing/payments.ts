/**
 * Payments — facts loaded from the QBO mirrors, never new tables.
 *
 * billing.customer_payment_methods and billing.customer_payments already
 * mirror QBO; these classes are the domain's view of those rows. A Payment is
 * a FACT (money observed), a PaymentMethod is a VALUE OBJECT describing how a
 * customer pays. Neither is mutable here — QBO is the source and the mirrors
 * are maintained by the sync writers.
 */

export class PaymentMethod {
  constructor(
    readonly qboPaymentMethodId: string,
    readonly kind: "card" | "bank" | "other",
    readonly brand: string | null,
    readonly lastFour: string | null,
    readonly active: boolean,
    /** Autopay uses this method — from billing.autopay_customers enrolment. */
    readonly autopayEnrolled: boolean,
  ) {}

  get label(): string {
    return `${this.brand ?? this.kind}${this.lastFour ? ` ····${this.lastFour}` : ""}`
  }

  /** The rule the collection loop asks: can this method be charged unattended? */
  get chargeable(): boolean {
    return this.active && this.autopayEnrolled
  }
}

/** An observed payment fact (billing.customer_payments row). */
export interface Payment {
  readonly qboPaymentId: string
  readonly amountCents: number
  readonly txnDate: string
  readonly methodName: string | null
  /** true when WE charged it (autopay); false when the customer paid. */
  readonly wasCharged: boolean
}

/** One payment applied to one invoice (billing.payment_invoice_links row). */
export interface PaymentApplication {
  readonly qboPaymentId: string
  readonly appliedCents: number
  readonly appliedAt: string
}
