import type { BillingMonth } from "@/lib/billing/domain"
import type { InvoiceCharger } from "@/lib/payments/application/invoice-charger"
import type { InvoiceSender, PaymentInstrument } from "@/lib/payments/domain/ports"

/**
 * PROCESS — the month's last automated act: collect if an instrument is
 * linked, then send, emitting facts at every transition.
 *
 * Collection is ONE ACTION: InvoiceCharger.chargeInvoice pairs the fresh
 * open-balance read with the Charge aggregate's ladder (RULED: you never
 * charge an invoice without asking what is owed at that moment, so the
 * pairing lives behind the method, not in every caller). This service only
 * sequences the month: charge each document, then send with attachments,
 * then markSent. A DECLINE stops the month unsent — the decline path
 * (retry cycle, dunning, disable) is a decision, not a loop. An UNKNOWN
 * stops harder: the adapter already tried query-before-retry, so a person
 * must look.
 */

export class ProcessRefused extends Error {}

export interface ProcessDeps {
  issuedInvoices(monthId: string): Promise<{ qboInvoiceId: string; kind: string; subtotalCents: number }[]>
  /** The instrument preprocess linked — resolved to its CURRENT state (a
   *  disable between preprocess and process must win). */
  instrument(paymentMethodId: string): Promise<PaymentInstrument | null>
  charger: InvoiceCharger
  sender: InvoiceSender
  /** The month's report PDF for attachment, if one was generated. */
  attachments(monthId: string): Promise<{ filename: string; pdf: Uint8Array }[]>
  save(month: BillingMonth): Promise<void>
}

export type ProcessOutcome =
  | { monthId: string; result: "sent"; charged: { qboInvoiceId: string; qboPaymentId: string; amountCents: number }[] }
  | { monthId: string; result: "declined"; reason: string; qboInvoiceId: string }
  | { monthId: string; result: "unknown"; detail: string; qboInvoiceId: string }

export async function processMonth(m: BillingMonth, deps: ProcessDeps, now: Date): Promise<ProcessOutcome> {
  if (!m.isPreprocessed) throw new ProcessRefused(`${m.month} was not preprocessed — the payment route is not resolved`)
  if (m.isSent) return { monthId: m.id, result: "sent", charged: [] } // level-triggered convergence

  const at = now.toISOString()
  const invoices = await deps.issuedInvoices(m.id)
  const charged: { qboInvoiceId: string; qboPaymentId: string; amountCents: number }[] = []

  /* ------------------------------ collection ------------------------------ */

  if (m.paymentMethodId) {
    // Re-resolve the instrument NOW: preprocess's link is the route, but a
    // 3-strike disable or user deactivation since then must win.
    const instrument = await deps.instrument(m.paymentMethodId)
    if (instrument?.active) {
      for (const inv of invoices) {
        const r = await deps.charger.chargeInvoice({ qboInvoiceId: inv.qboInvoiceId, customerId: m.customerId, instrument, at })
        if (r.outcome === "declined") {
          // The month does NOT send on a decline — what happens next is a
          // decision, not a loop.
          return { monthId: m.id, result: "declined", reason: r.reason, qboInvoiceId: inv.qboInvoiceId }
        }
        if (r.outcome === "unknown") {
          return { monthId: m.id, result: "unknown", detail: r.detail, qboInvoiceId: inv.qboInvoiceId }
        }
        if (r.outcome === "charged") charged.push({ qboInvoiceId: r.qboInvoiceId, qboPaymentId: r.qboPaymentId, amountCents: r.amountCents })
        // nothing_owed: someone already paid — fall through to sending.
      }
    }
    // instrument vanished/disabled since preprocess: fall through to
    // send-only — the email route is the answer for a routeless month.
  }

  /* -------------------------------- sending ------------------------------- */

  const attachments = await deps.attachments(m.id)
  for (const inv of invoices) {
    await deps.sender.send(inv.qboInvoiceId, attachments)
  }
  m.markSent(at)
  await deps.save(m)

  return { monthId: m.id, result: "sent", charged }
}
