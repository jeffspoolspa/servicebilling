import type { BillingMonth } from "@/lib/billing/domain"
import type { PaymentInstrument } from "@/lib/payments/domain/ports"

/**
 * PREPROCESS — between the invoice existing and anything shipping.
 *
 * Two questions, answered once and recorded on the month:
 *  1. CREDITS: any DECIDED maintenance credits apply to the new invoice(s)
 *     now. (The gate's credits_settled already held the month while credits
 *     were UNDECIDED — by the time we are here, what remains is applying
 *     the decisions.)
 *  2. ROUTE: is this customer on autopay with an ACTIVE instrument? Link it
 *     to the month; its absence IS the answer too — the send-only email
 *     route. Process never re-derives this.
 *
 * Idempotent: credit application is keyed per (payment, invoice) by the
 * applier; a re-run converges. markPreprocessed refuses out of order
 * (no invoice yet / already sent) — the aggregate is the sequence.
 */

export class PreprocessRefused extends Error {}

export interface AppliedCredit {
  paymentId: string
  qboInvoiceId: string
  appliedCents: number
}

export interface PreprocessDeps {
  /** The month's issued documents — preprocess needs the invoice ids. */
  issuedInvoices(monthId: string): Promise<{ qboInvoiceId: string; kind: string; subtotalCents: number }[]>
  /**
   * DECIDED, still-open maintenance credits for this customer. Undecided
   * credits held the month at the gate; they cannot appear here.
   */
  decidedOpenCredits(customerId: number): Promise<{ paymentId: string; unappliedCents: number }[]>
  /** Apply one credit against one invoice in QBO — idempotent per pair, echo-verified. */
  applyCredit(paymentId: string, qboInvoiceId: string, cents: number): Promise<AppliedCredit>
  /** The autopay roster's answer: the customer's current ACTIVE instrument, or null. */
  activeInstrument(customerId: number): Promise<PaymentInstrument | null>
  save(month: BillingMonth): Promise<void>
}

export interface PreprocessOutcome {
  monthId: string
  appliedCredits: AppliedCredit[]
  route: "autopay" | "email"
  paymentMethodId: string | null
}

export async function preprocessMonth(m: BillingMonth, deps: PreprocessDeps, now: Date): Promise<PreprocessOutcome> {
  if (!m.isInvoiced) throw new PreprocessRefused(`${m.month} has no invoice yet — preprocess follows issue`)
  if (m.isPreprocessed) {
    // Level-triggered: already answered. Converge, don't re-apply.
    return { monthId: m.id, appliedCredits: [], route: m.paymentMethodId ? "autopay" : "email", paymentMethodId: m.paymentMethodId }
  }

  const at = now.toISOString()
  const invoices = await deps.issuedInvoices(m.id)
  if (invoices.length === 0) throw new PreprocessRefused(`${m.month} is marked invoiced but has no issued documents — refusing to preprocess a ghost`)

  /* 1 — credits. Decided credits burn down against the invoices largest
   *     first, never past either side's remainder. */
  const credits = await deps.decidedOpenCredits(m.customerId)
  const applied: AppliedCredit[] = []
  const remaining = new Map(invoices.map((i) => [i.qboInvoiceId, i.subtotalCents]))
  for (const credit of credits) {
    let left = credit.unappliedCents
    for (const inv of [...invoices].sort((a, b) => b.subtotalCents - a.subtotalCents)) {
      if (left <= 0) break
      const room = remaining.get(inv.qboInvoiceId) ?? 0
      if (room <= 0) continue
      const cents = Math.min(left, room)
      applied.push(await deps.applyCredit(credit.paymentId, inv.qboInvoiceId, cents))
      remaining.set(inv.qboInvoiceId, room - cents)
      left -= cents
    }
  }

  /* 2 — the payment route. An inactive instrument is NO instrument: the
   *     3-strike disable and user deactivation both land here for free. */
  const instrument = await deps.activeInstrument(m.customerId)
  const methodId = instrument?.active ? instrument.paymentMethodId : null

  m.markPreprocessed(methodId, at, applied.length)
  await deps.save(m)

  return { monthId: m.id, appliedCredits: applied, route: methodId ? "autopay" : "email", paymentMethodId: methodId }
}
