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

export interface OpenCreditRef {
  kind: "payment" | "credit_memo"
  id: string
  availableCents: number
  memo: string
}

export interface AppliedCredit {
  kind: "payment" | "credit_memo"
  creditId: string
  qboInvoiceId: string
  appliedCents: number
  /** The $0 linking Payment a credit-memo application creates. */
  createdPaymentId?: string
}

export interface PreprocessInvoiceDeps {
  /** Already preprocessed? Level-triggered convergence, never re-applied. */
  preprocessedAt(qboInvoiceId: string): Promise<string | null>
  /**
   * Open credits for this customer — RULED: BOTH unapplied Payments AND
   * CreditMemos with remaining credit, maint-memo'd. Kind-scoped policy.
   */
  openCredits(customerId: number, kind: InvoiceRef["kind"]): Promise<OpenCreditRef[]>
  /** The invoice's open balance, FRESH — the room a credit may fill. */
  openBalance(qboInvoiceId: string): Promise<number>
  /** Apply one credit against this invoice in QBO — echo-verified; self-converging (both sides shrink). */
  applyCredit(credit: OpenCreditRef, qboInvoiceId: string, cents: number): Promise<AppliedCredit>
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

  /* 1 — credits. The room is the FRESH open balance (not the subtotal),
   *     which is what makes a crashed re-run self-converging: both the
   *     credit's remainder and the balance shrank with the first pass, so
   *     min(available, room) applies only what is still owed. */
  const credits = await deps.openCredits(inv.customerId, inv.kind)
  const applied: AppliedCredit[] = []
  if (credits.length > 0) {
    await deps.emit(
      "credits_matched",
      { qbo_invoice_id: inv.qboInvoiceId, credits: credits.map((c) => ({ kind: c.kind, id: c.id, available_cents: c.availableCents, memo: c.memo })) },
      [inv.linkedTo.id],
      at,
    )
    let room = await deps.openBalance(inv.qboInvoiceId)
    for (const credit of credits) {
      if (room <= 0) break
      const cents = Math.min(credit.availableCents, room)
      if (cents <= 0) continue
      const a = await deps.applyCredit(credit, inv.qboInvoiceId, cents)
      applied.push(a)
      room -= cents
      await deps.emit(
        "credit_applied",
        { qbo_invoice_id: inv.qboInvoiceId, kind: a.kind, credit_id: a.creditId, applied_cents: a.appliedCents, ...(a.createdPaymentId ? { created_payment_id: a.createdPaymentId } : {}) },
        [inv.linkedTo.id],
        at,
      )
    }
  }

  // The payment route is NOT resolved here (RULED: resolution is a query,
  // not a stage) — collect asks the roster live at its own claim time.
  await deps.markCreditsChecked(inv.qboInvoiceId, at)
  await deps.emit(
    "invoice_credits_checked",
    { qbo_invoice_id: inv.qboInvoiceId, credits_matched: credits.length, credits_applied: applied.length, kind: inv.kind },
    [inv.linkedTo.id],
    at,
  )

  return { qboInvoiceId: inv.qboInvoiceId, appliedCredits: applied }
}
