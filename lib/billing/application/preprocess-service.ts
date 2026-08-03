import type { PaymentInstrument } from "@/lib/payments/domain/ports"

/**
 * PREPROCESS — an INVOICE step (RULED: after creation each invoice runs its
 * own machine; the month only tracks). Two questions, answered once per
 * invoice, events emitted with the linked billing month (or work order) as
 * a PARTICIPANT so the parent's history assembles the whole story:
 *
 *  1. CREDITS: any DECIDED open credits apply to this invoice now.
 *  2. ROUTE: the customer's ACTIVE instrument links to the invoice; its
 *     absence IS the answer too — the send-only email route.
 *
 * The POLICY behind both ports is scoped by the invoice's KIND — which is
 * defined by what it is LINKED TO (billing month -> maintenance: the
 * autopay ROSTER decides; work order -> service: its own resolver).
 */

export class PreprocessRefused extends Error {}

export interface InvoiceRef {
  qboInvoiceId: string
  customerId: number
  /** What the invoice is linked to defines its kind and its policies. */
  kind: "maintenance" | "service"
  /** The parent aggregate id — a PARTICIPANT on every event emitted here. */
  linkedTo: { aggregate: "billing_month" | "work_order"; id: string }
  subtotalCents: number
}

export interface AppliedCredit {
  paymentId: string
  qboInvoiceId: string
  appliedCents: number
}

export interface PreprocessInvoiceDeps {
  /** Already preprocessed? Level-triggered convergence, never re-applied. */
  preprocessedAt(qboInvoiceId: string): Promise<string | null>
  /** DECIDED, still-open credits for this customer — kind-scoped policy. */
  decidedOpenCredits(customerId: number, kind: InvoiceRef["kind"]): Promise<{ paymentId: string; unappliedCents: number }[]>
  /** Apply one credit against this invoice in QBO — idempotent per pair, echo-verified (mirror rides the echo). */
  applyCredit(paymentId: string, qboInvoiceId: string, cents: number): Promise<AppliedCredit>
  /**
   * The payment route, kind-scoped: maintenance = ON the autopay roster
   * with an active method; service = its own resolver. Inactive = null.
   */
  activeInstrument(customerId: number, kind: InvoiceRef["kind"]): Promise<PaymentInstrument | null>
  /** Record the answer ON the invoice (the machine's state, not the month's). */
  linkInstrument(qboInvoiceId: string, paymentMethodId: string | null, at: string): Promise<void>
  /** Emit a fact with the parent as participant. */
  emit(type: string, payload: Record<string, unknown>, participants: string[], at: string): Promise<void>
}

export interface PreprocessOutcome {
  qboInvoiceId: string
  appliedCredits: AppliedCredit[]
  route: "autopay" | "email"
  paymentMethodId: string | null
}

export async function preprocessInvoice(inv: InvoiceRef, deps: PreprocessInvoiceDeps, now: Date): Promise<PreprocessOutcome> {
  const at = now.toISOString()
  const already = await deps.preprocessedAt(inv.qboInvoiceId)
  if (already) {
    return { qboInvoiceId: inv.qboInvoiceId, appliedCredits: [], route: "email", paymentMethodId: null }
  }

  /* 1 — credits: decided credits burn down, never past either remainder. */
  const credits = await deps.decidedOpenCredits(inv.customerId, inv.kind)
  const applied: AppliedCredit[] = []
  let room = inv.subtotalCents
  for (const credit of credits) {
    if (room <= 0) break
    const cents = Math.min(credit.unappliedCents, room)
    if (cents <= 0) continue
    applied.push(await deps.applyCredit(credit.paymentId, inv.qboInvoiceId, cents))
    room -= cents
  }

  /* 2 — the route. An inactive instrument is NO instrument. */
  const instrument = await deps.activeInstrument(inv.customerId, inv.kind)
  const methodId = instrument?.active ? instrument.paymentMethodId : null
  await deps.linkInstrument(inv.qboInvoiceId, methodId, at)

  await deps.emit(
    "invoice_preprocessed",
    { qbo_invoice_id: inv.qboInvoiceId, route: methodId ? "autopay" : "email", payment_method_id: methodId, credits_applied: applied.length, kind: inv.kind },
    [inv.linkedTo.id],
    at,
  )

  return { qboInvoiceId: inv.qboInvoiceId, appliedCredits: applied, route: methodId ? "autopay" : "email", paymentMethodId: methodId }
}
