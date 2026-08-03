import type { BillingMonth } from "@/lib/billing/domain"
import { Charge } from "@/lib/payments/domain/charge"
import type { CardCharger, ChargeRepository, InvoiceSender, PaymentInstrument, PaymentRecorder, ReceiptSender } from "@/lib/payments/domain/ports"

/**
 * PROCESS — the month's last automated act: collect if an instrument is
 * linked, then send, emitting facts at every transition.
 *
 * The orchestration NEVER decides — the Charge aggregate does. This service
 * loads or requests the charge, asks the ports to act, and hands each
 * outcome back to the aggregate to record, saving after every money fact so
 * a crash between steps leaves a resumable, honest state:
 *
 *   charge (processor)  ->  record Payment (accounting)  ->  receipt
 *   -- each step idempotent by the charge's DOMAIN key (invoiceId:cycle) --
 *
 * then send the invoice with its attachments and markSent. A DECLINE stops
 * the month (no send) and surfaces — the decline path (retry cycle, dunning
 * email, disable) is a decision, not a loop. An UNKNOWN outcome stops
 * harder: the adapter already tried query-before-retry, so the truth is
 * genuinely unknowable right now and a person must look.
 */

export class ProcessRefused extends Error {}

export interface ProcessDeps {
  issuedInvoices(monthId: string): Promise<{ qboInvoiceId: string; kind: string; subtotalCents: number }[]>
  /**
   * The invoice's OPEN BALANCE, read FRESH from QBO at the moment of truth
   * — never the cache. QBO is the system of record for balance (ADR-010:
   * applications are facts, balance is the fold, checksummed against QBO).
   * This is the guard the Charge aggregate cannot be: our loop's identity
   * (invoiceId:cycle) stops US double-charging, but only the balance knows
   * about the check that arrived yesterday.
   */
  openBalance(qboInvoiceId: string): Promise<number>
  /** The instrument preprocess linked — resolved to its current state (a
   *  disable between preprocess and process must win). */
  instrument(paymentMethodId: string): Promise<PaymentInstrument | null>
  charges: ChargeRepository
  charger: CardCharger
  recorder: PaymentRecorder
  receipts: ReceiptSender
  sender: InvoiceSender
  /** The month's report PDF for attachment, if one was generated. */
  attachments(monthId: string): Promise<{ filename: string; pdf: Uint8Array }[]>
  save(month: BillingMonth): Promise<void>
  newChargeId(): string
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
        // The moment-of-truth read: charge what is OWED, not what was
        // billed. A check that arrived yesterday, a partial payment, a
        // credit applied after issue — the balance knows; our cache and the
        // subtotal do not. Zero balance = nothing to collect, fall through
        // to sending.
        const balanceCents = await deps.openBalance(inv.qboInvoiceId)
        if (balanceCents <= 0) continue

        // One charge per invoice per CYCLE — a crashed run resumes ITS
        // charge; a re-decision after a decline mints a new cycle.
        const cycle = await deps.charges.nextCycle(inv.qboInvoiceId)
        const charge =
          (await deps.charges.openFor(inv.qboInvoiceId, cycle)) ??
          Charge.request({
            id: deps.newChargeId(),
            invoiceId: inv.qboInvoiceId,
            qboInvoiceId: inv.qboInvoiceId,
            customerId: m.customerId,
            paymentMethodId: instrument.paymentMethodId,
            amountCents: balanceCents,
            cycle,
            at,
          })

        if (charge.status === "requested") {
          const result = await deps.charger.charge(instrument, charge.amountCents, charge.idempotencyKey)
          if (result.outcome === "declined") {
            charge.markDeclined(result.reason, at)
            await deps.charges.save(charge)
            // The month does NOT send on a decline — what happens next
            // (retry cycle, dunning, disable) is a decision, not a loop.
            return { monthId: m.id, result: "declined", reason: result.reason, qboInvoiceId: inv.qboInvoiceId }
          }
          if (result.outcome === "unknown") {
            await deps.charges.save(charge) // still "requested" — resumable
            return { monthId: m.id, result: "unknown", detail: result.detail, qboInvoiceId: inv.qboInvoiceId }
          }
          charge.markSettled(result.processorRef, at)
          await deps.charges.save(charge) // settle is durable before accounting
        }

        if (charge.status === "settled") {
          const { qboPaymentId } = await deps.recorder.record(inv.qboInvoiceId, charge.amountCents, charge.idempotencyKey)
          charge.markPaymentRecorded(qboPaymentId, at)
          await deps.charges.save(charge)
        }

        if (charge.status === "recorded") {
          await deps.receipts.send(m.customerId, charge.paymentId!, charge.amountCents)
          charge.markReceipted(at)
          await deps.charges.save(charge)
        }

        charged.push({ qboInvoiceId: inv.qboInvoiceId, qboPaymentId: charge.paymentId!, amountCents: charge.amountCents })
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
