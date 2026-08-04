import type { InvoiceCharger } from "@/lib/payments/application/invoice-charger"
import type { InvoiceSender, PaymentInstrument } from "@/lib/payments/domain/ports"
import type { InvoiceRef } from "./preprocess-service"

/**
 * The machine's COLLECT and SEND stages — separate advances on purpose
 * (RULED: one advance function per stage, never one script that runs
 * everything). A crash resumes at the stage; a send failure never
 * re-touches a settled charge; each stage records its own moment and emits
 * its own fact with the parent as PARTICIPANT.
 *
 * COLLECT records an OUTCOME (charged / nothing_owed / declined / unknown /
 * no_instrument) so a resolved collection never re-asks — and
 * invoiceNextStep PARKS declined/unknown for a person instead of looping.
 */

export interface CollectDeps {
  /** The instrument preprocess linked — re-resolved to its CURRENT state. */
  linkedInstrument(qboInvoiceId: string): Promise<PaymentInstrument | null>
  charger: InvoiceCharger
  emit(type: string, payload: Record<string, unknown>, participants: string[], at: string): Promise<void>
}

export type CollectOutcome =
  | { qboInvoiceId: string; outcome: "charged"; qboPaymentId: string; amountCents: number }
  | { qboInvoiceId: string; outcome: "nothing_owed" | "declined" | "unknown" | "no_instrument"; detail?: string }

export async function collectInvoice(inv: InvoiceRef, deps: CollectDeps, now: Date): Promise<CollectOutcome> {
  const at = now.toISOString()
  // No tags anywhere: the outcome IS the charge row (billing.charges) plus
  // the mirror the fresh balance read updates on its way through — the
  // next derive sees both and moves along or parks on its own.
  const instrument = await deps.linkedInstrument(inv.qboInvoiceId)
  if (!instrument?.active) {
    // Disabled since preprocess: the derive sees no linked/active method
    // next time; the email route is the answer now.
    return { qboInvoiceId: inv.qboInvoiceId, outcome: "no_instrument" }
  }

  const r = await deps.charger.chargeInvoice({ qboInvoiceId: inv.qboInvoiceId, customerId: inv.customerId, instrument, at })
  if (r.outcome === "declined") {
    await deps.emit("charge_declined", { qbo_invoice_id: inv.qboInvoiceId, reason: r.reason }, [inv.linkedTo.id], at)
    return { qboInvoiceId: inv.qboInvoiceId, outcome: "declined", detail: r.reason }
  }
  if (r.outcome === "unknown") {
    await deps.emit("charge_uncertain", { qbo_invoice_id: inv.qboInvoiceId, detail: r.detail }, [inv.linkedTo.id], at)
    return { qboInvoiceId: inv.qboInvoiceId, outcome: "unknown", detail: r.detail }
  }
  if (r.outcome === "nothing_owed") {
    return { qboInvoiceId: inv.qboInvoiceId, outcome: "nothing_owed" }
  }
  await deps.emit("charge_captured", { qbo_invoice_id: inv.qboInvoiceId, qbo_payment_id: r.qboPaymentId, amount_cents: r.amountCents }, [inv.linkedTo.id], at)
  return { qboInvoiceId: inv.qboInvoiceId, outcome: "charged", qboPaymentId: r.qboPaymentId, amountCents: r.amountCents }
}

export interface SendDeps {
  sender: InvoiceSender
  attachments(inv: InvoiceRef): Promise<{ filename: string; pdf: Uint8Array }[]>
  emit(type: string, payload: Record<string, unknown>, participants: string[], at: string): Promise<void>
}

export async function sendInvoiceStep(inv: InvoiceRef, deps: SendDeps, now: Date): Promise<{ qboInvoiceId: string; sent: true }> {
  const at = now.toISOString()
  // The sender's echo flips the mirror's email_status — which is exactly
  // what invoiceNextStep reads, so a re-run converges without a flag.
  await deps.sender.send(inv.qboInvoiceId, await deps.attachments(inv))
  await deps.emit("invoice_emailed", { qbo_invoice_id: inv.qboInvoiceId, kind: inv.kind }, [inv.linkedTo.id], at)
  return { qboInvoiceId: inv.qboInvoiceId, sent: true }
}
