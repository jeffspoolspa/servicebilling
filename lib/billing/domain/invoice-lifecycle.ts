/**
 * The INVOICE machine — the one statement of the post-creation sequence.
 *
 * RULED: after creation each invoice runs its own machine, level-triggered
 * from STATE QUERIES (never remembered from events): enrich is folded into
 * creation, then credit_check -> collect -> send. The command names the
 * SUBJECT (AdvanceInvoice); the handler asks THIS function at claim time,
 * so a stale command can never run a stale step.
 *
 * Parking: a declined or unknown collection returns null — a person's
 * problem, not a retry loop. No instrument skips collect entirely (the
 * email route). "Paid" needs no step: the webhook/mirror feeds the month's
 * closed fold without the machine's involvement.
 */

export type InvoiceStep = "credit_check" | "collect" | "send" | null

export interface InvoiceMachineState {
  readonly preprocessedAt: string | null
  readonly linkedPaymentMethodId: string | null
  readonly collectedAt: string | null
  readonly collectOutcome: "charged" | "nothing_owed" | "declined" | "unknown" | "no_instrument" | null
  readonly emailStatus: string | null
}

export function invoiceNextStep(s: InvoiceMachineState): InvoiceStep {
  if (!s.preprocessedAt) return "credit_check"
  if (s.linkedPaymentMethodId && !s.collectedAt) return "collect"
  // A decline stops the invoice UNSENT — what happens next is a decision.
  if (s.collectOutcome === "declined" || s.collectOutcome === "unknown") return null
  if (s.emailStatus !== "EmailSent") return "send"
  return null
}
