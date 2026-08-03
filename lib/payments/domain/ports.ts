/**
 * The payments context's PORTS — declared here, in this domain's language,
 * implemented in infrastructure. CardCharger and PaymentRecorder are
 * deliberately SEPARATE even though both say "QuickBooks": QBO Payments
 * (the processor that moves money) and QBO Accounting (the Payment entity
 * against the invoice) are different external systems with different
 * failure modes — one class pretending they are one thing is how a settled
 * charge ends up unrecorded. Swapping processors = a new adapter behind
 * CardCharger; the domain never notices.
 */

import type { Charge } from "./charge"

/** A vaulted instrument, as the domain needs to know it — never the PAN. */
export interface PaymentInstrument {
  readonly paymentMethodId: string
  readonly kind: "card" | "ach"
  /** Disabled by the 3-strike rule or by a person; a disabled instrument never charges. */
  readonly active: boolean
}

export type ChargeAttemptResult =
  | { outcome: "settled"; processorRef: string }
  | { outcome: "declined"; reason: string }
  /**
   * The wire went dark mid-flight. The adapter MUST have already tried
   * query-before-retry with the idempotency key; "unknown" surfaces only
   * when the truth is genuinely unknowable right now — a person's problem,
   * never an automatic retry.
   */
  | { outcome: "unknown"; detail: string }

/** The processor: moves money. Idempotent by the charge's domain key. */
export interface CardCharger {
  charge(instrument: PaymentInstrument, amountCents: number, idempotencyKey: string): Promise<ChargeAttemptResult>
}

/** The accounting side: the Payment entity applied against the invoice. */
export interface PaymentRecorder {
  /** Echo-verified create; idempotent — an existing payment for this charge converges. */
  record(qboInvoiceId: string, amountCents: number, idempotencyKey: string): Promise<{ qboPaymentId: string }>
}

export interface ReceiptSender {
  send(customerId: number, qboPaymentId: string, amountCents: number): Promise<void>
}

/** Sends the invoice itself, with any attached documents (the usage report). */
export interface InvoiceSender {
  send(qboInvoiceId: string, attachments: readonly { filename: string; pdf: Uint8Array }[]): Promise<void>
}

export interface ChargeRepository {
  /** The open charge for this invoice+cycle, if the last run left one. */
  openFor(invoiceId: string, cycle: number): Promise<Charge | null>
  save(charge: Charge): Promise<void>
  nextCycle(invoiceId: string): Promise<number>
}
