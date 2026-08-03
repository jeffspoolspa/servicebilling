import type { InvoiceCharger } from "@/lib/payments/application/invoice-charger"
import type { InvoiceSender, PaymentInstrument } from "@/lib/payments/domain/ports"
import type { InvoiceRef } from "./preprocess-service"

/**
 * PROCESS — an INVOICE step: collect if an instrument is linked, then send.
 * The invoice's own machine (RULED): the month ended at creation and only
 * tracks; every event emitted here carries the parent as a PARTICIPANT.
 *
 * Collection is ONE ACTION — InvoiceCharger.chargeInvoice pairs the fresh
 * open-balance read with the Charge aggregate's ladder. A DECLINE stops
 * this invoice unsent and surfaces; UNKNOWN stops harder (the adapter
 * already query-before-retried). nothing_owed falls through to sending —
 * someone already paid.
 */

export class ProcessRefused extends Error {}

export interface ProcessInvoiceDeps {
  /** The instrument preprocess linked — re-resolved to its CURRENT state. */
  linkedInstrument(qboInvoiceId: string): Promise<PaymentInstrument | null>
  charger: InvoiceCharger
  sender: InvoiceSender
  /** Attachments for THIS invoice (the month's usage report rides the maintenance service invoice). */
  attachments(inv: InvoiceRef): Promise<{ filename: string; pdf: Uint8Array }[]>
  sentAt(qboInvoiceId: string): Promise<string | null>
  emit(type: string, payload: Record<string, unknown>, participants: string[], at: string): Promise<void>
}

export type ProcessInvoiceOutcome =
  | { qboInvoiceId: string; result: "sent"; charged: { qboPaymentId: string; amountCents: number } | null }
  | { qboInvoiceId: string; result: "declined"; reason: string }
  | { qboInvoiceId: string; result: "unknown"; detail: string }

export async function processInvoice(inv: InvoiceRef, deps: ProcessInvoiceDeps, now: Date): Promise<ProcessInvoiceOutcome> {
  const at = now.toISOString()
  if (await deps.sentAt(inv.qboInvoiceId)) {
    return { qboInvoiceId: inv.qboInvoiceId, result: "sent", charged: null } // convergence
  }

  let charged: { qboPaymentId: string; amountCents: number } | null = null
  const instrument = await deps.linkedInstrument(inv.qboInvoiceId)
  if (instrument?.active) {
    const r = await deps.charger.chargeInvoice({ qboInvoiceId: inv.qboInvoiceId, customerId: inv.customerId, instrument, at })
    if (r.outcome === "declined") {
      await deps.emit("charge_declined", { qbo_invoice_id: inv.qboInvoiceId, reason: r.reason }, [inv.linkedTo.id], at)
      return { qboInvoiceId: inv.qboInvoiceId, result: "declined", reason: r.reason }
    }
    if (r.outcome === "unknown") {
      await deps.emit("charge_uncertain", { qbo_invoice_id: inv.qboInvoiceId, detail: r.detail }, [inv.linkedTo.id], at)
      return { qboInvoiceId: inv.qboInvoiceId, result: "unknown", detail: r.detail }
    }
    if (r.outcome === "charged") {
      charged = { qboPaymentId: r.qboPaymentId, amountCents: r.amountCents }
      await deps.emit("charge_captured", { qbo_invoice_id: inv.qboInvoiceId, qbo_payment_id: r.qboPaymentId, amount_cents: r.amountCents }, [inv.linkedTo.id], at)
    }
    // nothing_owed: fall through to sending.
  }

  await deps.sender.send(inv.qboInvoiceId, await deps.attachments(inv))
  await deps.emit("invoice_emailed", { qbo_invoice_id: inv.qboInvoiceId, kind: inv.kind }, [inv.linkedTo.id], at)
  return { qboInvoiceId: inv.qboInvoiceId, result: "sent", charged }
}
