/**
 * The INVOICE machine — the one statement of the post-creation sequence.
 *
 * RULED (Carter, 2026-08-04): collect-needed is DERIVED, never tagged —
 * a reading of (linked instrument ∧ open balance ∧ no charge attempt),
 * so there is no marker to go stale. The self-resolving trick: the collect
 * stage's fresh balance read updates the MIRROR on its way through, so a
 * nothing-owed invoice derives "move along" on the next look without any
 * recorded outcome.
 *
 *  - no instrument linked  -> collect never happens (the email route)
 *  - balance <= 0          -> nothing to collect, move along
 *  - a SETTLED attempt     -> collected, move along
 *  - an IN-FLIGHT attempt  -> resume the ladder (idempotent by cycle key)
 *  - a DECLINED attempt    -> PARK unsent — a person mints the next cycle
 *    (the earlier ruling stands: a decline stops the invoice, it does not
 *    quietly fall through to send)
 */

export type InvoiceStep = "credit_check" | "collect" | "send" | null

export type ChargeAttemptStatus = "none" | "requested" | "settled" | "recorded" | "receipted" | "declined"

export interface InvoiceMachineState {
  /** The credit-check stage's moment (the one ACT preprocess kept). */
  readonly preprocessedAt: string | null
  /**
   * DERIVED live from the roster at claim time — payment-method resolution
   * is a QUERY, not a stage (RULED: 2026-08-04). The method actually used
   * is recorded on the charge row, where provenance belongs.
   */
  readonly hasActiveInstrument: boolean
  /** The MIRROR's balance — kept warm by every echo; webhooks converge it. */
  readonly mirrorBalanceCents: number
  /** The latest charge attempt for this invoice, from billing.charges. */
  readonly latestCharge: ChargeAttemptStatus
  readonly emailStatus: string | null
}

export function invoiceNextStep(s: InvoiceMachineState): InvoiceStep {
  if (!s.preprocessedAt) return "credit_check"
  if (s.latestCharge === "declined") return null // parked — a person decides
  if (
    s.hasActiveInstrument &&
    s.mirrorBalanceCents > 0 &&
    (s.latestCharge === "none" || s.latestCharge === "requested" || s.latestCharge === "settled" || s.latestCharge === "recorded")
  ) {
    // none: first attempt. requested/settled/recorded: the ladder resumes
    // at its exact rung (charge -> record -> receipt), idempotent by key.
    return "collect"
  }
  if (s.emailStatus !== "EmailSent") return "send"
  return null
}
