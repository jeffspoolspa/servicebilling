import type { PaymentInstrument } from "@/lib/payments/domain/ports"

/**
 * CREDIT CHECK — the machine's one preprocess-era ACT (RULED 2026-08-04:
 * payment-method resolution is a QUERY, not a stage — collect derives the
 * instrument live from the roster; only side-effectful work earns a stage
 * and a moment). Any DECIDED open credits apply to this invoice now; the
 * event carries the linked billing month (or work order) as PARTICIPANT.
 * Policy is scoped by the invoice's KIND — defined by what it is LINKED TO.
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
  /** Stamp the stage's moment — credits checked. */
  markCreditsChecked(qboInvoiceId: string, at: string): Promise<void>
  /** Emit a fact with the parent as participant. */
  emit(type: string, payload: Record<string, unknown>, participants: string[], at: string): Promise<void>
}

export interface PreprocessOutcome {
  qboInvoiceId: string
  appliedCredits: AppliedCredit[]
}

export async function preprocessInvoice(inv: InvoiceRef, deps: PreprocessInvoiceDeps, now: Date): Promise<PreprocessOutcome> {
  const at = now.toISOString()
  const already = await deps.preprocessedAt(inv.qboInvoiceId)
  if (already) {
    return { qboInvoiceId: inv.qboInvoiceId, appliedCredits: [] }
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

  // The payment route is NOT resolved here (RULED: resolution is a query,
  // not a stage) — collect asks the roster live at its own claim time.
  await deps.markCreditsChecked(inv.qboInvoiceId, at)
  await deps.emit(
    "invoice_credits_checked",
    { qbo_invoice_id: inv.qboInvoiceId, credits_applied: applied.length, kind: inv.kind },
    [inv.linkedTo.id],
    at,
  )

  return { qboInvoiceId: inv.qboInvoiceId, appliedCredits: applied }
}
