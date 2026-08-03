/**
 * The CHARGE aggregate — the payments context's unit of decision.
 *
 * A Charge is our ATTEMPT to collect an invoice; it is NOT a Payment. A
 * Payment is settled money as an accounting fact, and Payments also arrive
 * with no Charge at all (checks, external QBO payments). The Charge owns
 * the attempt's lifecycle and its invariants; it holds no HTTP — the
 * application service asks it what is permitted, calls a port, and hands
 * the outcome back to be recorded.
 *
 * Invariants:
 *  - the IDEMPOTENCY KEY is domain identity: invoiceId:cycle. One charge
 *    per invoice per cycle; a retry is the SAME charge converging, never a
 *    second one.
 *  - a charge cannot settle twice, and cannot settle after a decline —
 *    a new cycle is a new decision, made by a person or a ruled policy.
 *  - the QBO Payment is recorded only AFTER settlement, the receipt only
 *    after recording — money facts are written in the order they became
 *    true, so a crash between steps leaves a resumable, honest state.
 *  - a decline consumes an attempt against the INSTRUMENT (the 3-strike
 *    auto-disable is the PaymentMethod's rule; the charge just reports).
 */

export class ChargeRuleError extends Error {}

export type ChargeStatus = "requested" | "settled" | "recorded" | "receipted" | "declined"

export interface ChargeFact {
  type: "ChargeRequested" | "ChargeSettled" | "ChargeDeclined" | "PaymentRecorded" | "ReceiptSent"
  chargeId: string
  at: string
  payload: Record<string, unknown>
}

export class Charge {
  private facts: ChargeFact[] = []

  private constructor(
    readonly id: string,
    readonly invoiceId: string,
    readonly qboInvoiceId: string,
    readonly customerId: number,
    readonly paymentMethodId: string,
    readonly amountCents: number,
    /** One collection cycle per invoice — a re-decision mints a new cycle. */
    readonly cycle: number,
    private settledAt: string | null,
    private declinedAt: string | null,
    private declineReason: string | null,
    private qboPaymentId: string | null,
    private receiptedAt: string | null,
  ) {}

  /** The domain identity the wire-level idempotency enforces. */
  get idempotencyKey(): string {
    return `${this.invoiceId}:${this.cycle}`
  }

  get status(): ChargeStatus {
    if (this.declinedAt) return "declined"
    if (this.receiptedAt) return "receipted"
    if (this.qboPaymentId) return "recorded"
    if (this.settledAt) return "settled"
    return "requested"
  }

  get paymentId(): string | null {
    return this.qboPaymentId
  }

  static request(args: {
    id: string
    invoiceId: string
    qboInvoiceId: string
    customerId: number
    paymentMethodId: string
    amountCents: number
    cycle: number
    at: string
  }): Charge {
    if (args.amountCents <= 0) throw new ChargeRuleError(`a charge must be for money, got ${args.amountCents}`)
    const c = new Charge(args.id, args.invoiceId, args.qboInvoiceId, args.customerId, args.paymentMethodId, args.amountCents, args.cycle, null, null, null, null, null)
    c.facts.push({ type: "ChargeRequested", chargeId: args.id, at: args.at, payload: { invoiceId: args.invoiceId, amountCents: args.amountCents, paymentMethodId: args.paymentMethodId, cycle: args.cycle } })
    return c
  }

  static reconstitute(args: {
    id: string; invoiceId: string; qboInvoiceId: string; customerId: number; paymentMethodId: string
    amountCents: number; cycle: number; settledAt?: string | null; declinedAt?: string | null
    declineReason?: string | null; qboPaymentId?: string | null; receiptedAt?: string | null
  }): Charge {
    return new Charge(
      args.id, args.invoiceId, args.qboInvoiceId, args.customerId, args.paymentMethodId,
      args.amountCents, args.cycle, args.settledAt ?? null, args.declinedAt ?? null,
      args.declineReason ?? null, args.qboPaymentId ?? null, args.receiptedAt ?? null,
    )
  }

  /** The processor took the money. */
  markSettled(processorRef: string, at: string): void {
    if (this.declinedAt) throw new ChargeRuleError(`charge ${this.id} was declined — a new cycle is a new decision`)
    if (this.settledAt) return // converging retry, not a second settle
    this.settledAt = at
    this.facts.push({ type: "ChargeSettled", chargeId: this.id, at, payload: { processorRef, amountCents: this.amountCents } })
  }

  markDeclined(reason: string, at: string): void {
    if (this.settledAt) throw new ChargeRuleError(`charge ${this.id} already settled — it cannot decline`)
    if (this.declinedAt) return
    this.declinedAt = at
    this.declineReason = reason
    this.facts.push({ type: "ChargeDeclined", chargeId: this.id, at, payload: { reason, paymentMethodId: this.paymentMethodId } })
  }

  /** The accounting side caught up: the QBO Payment exists against the invoice. */
  markPaymentRecorded(qboPaymentId: string, at: string): void {
    if (!this.settledAt) throw new ChargeRuleError(`charge ${this.id} has not settled — money facts are written in the order they became true`)
    if (this.qboPaymentId) return
    this.qboPaymentId = qboPaymentId
    this.facts.push({ type: "PaymentRecorded", chargeId: this.id, at, payload: { qboPaymentId, qboInvoiceId: this.qboInvoiceId } })
  }

  markReceipted(at: string): void {
    if (!this.qboPaymentId) throw new ChargeRuleError(`charge ${this.id} has no recorded payment — the receipt describes the record`)
    if (this.receiptedAt) return
    this.receiptedAt = at
    this.facts.push({ type: "ReceiptSent", chargeId: this.id, at, payload: {} })
  }

  pullFacts(): ChargeFact[] {
    const out = this.facts
    this.facts = []
    return out
  }
}
