import { Charge, paymentMemo } from "@/lib/payments/domain/charge"
import type { CardCharger, ChargeRepository, PaymentInstrument, PaymentRecorder, ReceiptSender } from "@/lib/payments/domain/ports"

/**
 * InvoiceCharger.chargeInvoice — paying an invoice as ONE ACTION.
 *
 * RULED (Carter, 2026-08-03): the open-balance read and the charge always
 * travel together — you never charge an invoice without asking what is owed
 * at that moment, so the pairing is abstracted behind one method instead of
 * trusted to every caller. Same consolidation we did when the primitive
 * function list became actions, now organized as an object.
 *
 * The full action: fresh balance -> nothing owed? done -> the Charge
 * aggregate's ladder (request -> charge -> settle -> record payment ->
 * receipt), a save after every money fact so a crash resumes exactly where
 * truth stopped. The aggregate decides; this object sequences.
 */

export interface InvoiceChargerDeps {
  /** Fresh from QBO at the moment of truth — never the cache. */
  openBalance(qboInvoiceId: string): Promise<number>
  charges: ChargeRepository
  charger: CardCharger
  recorder: PaymentRecorder
  receipts: ReceiptSender
  newChargeId(): string
}

export type ChargeInvoiceOutcome =
  | { outcome: "nothing_owed"; qboInvoiceId: string }
  | { outcome: "charged"; qboInvoiceId: string; qboPaymentId: string; amountCents: number }
  | { outcome: "declined"; qboInvoiceId: string; reason: string }
  | { outcome: "unknown"; qboInvoiceId: string; detail: string }

export class InvoiceCharger {
  constructor(private readonly deps: InvoiceChargerDeps) {}

  async chargeInvoice(args: {
    qboInvoiceId: string
    customerId: number
    instrument: PaymentInstrument
    /** "July Pool Maintenance" — the same memo the invoice carries. */
    monthLabel: string
    /** The invoice's DocNumber — how a person finds it from the memo. */
    docNumber: string
    at: string
  }): Promise<ChargeInvoiceOutcome> {
    const { qboInvoiceId, customerId, instrument, at } = args
    if (!instrument.active) return { outcome: "declined", qboInvoiceId, reason: "instrument is disabled" }

    // The moment-of-truth read: charge what is OWED, not what was billed.
    // A check that arrived yesterday, a partial payment, a credit applied
    // after issue — the balance knows; the subtotal and the cache do not.
    const balanceCents = await this.deps.openBalance(qboInvoiceId)
    if (balanceCents <= 0) return { outcome: "nothing_owed", qboInvoiceId }

    // One charge per invoice per CYCLE — a crashed run resumes ITS charge;
    // a re-decision after a decline mints a new cycle.
    let chargedLabel: string | null = instrument.label
    const cycle = await this.deps.charges.nextCycle(qboInvoiceId)
    const charge =
      (await this.deps.charges.openFor(qboInvoiceId, cycle)) ??
      Charge.request({
        id: this.deps.newChargeId(),
        invoiceId: qboInvoiceId,
        qboInvoiceId,
        customerId,
        paymentMethodId: instrument.paymentMethodId,
        amountCents: balanceCents,
        cycle,
        at,
      })

    if (charge.status === "requested") {
      const result = await this.deps.charger.charge(instrument, charge.amountCents, charge.idempotencyKey)
      if (result.outcome === "declined") {
        charge.markDeclined(result.reason, at)
        await this.deps.charges.save(charge)
        return { outcome: "declined", qboInvoiceId, reason: result.reason }
      }
      if (result.outcome === "unknown") {
        await this.deps.charges.save(charge) // still "requested" — resumable
        return { outcome: "unknown", qboInvoiceId, detail: result.detail }
      }
      charge.markSettled(result.processorRef, result.authCode ?? null, at)
      if (result.label) chargedLabel = result.label
      await this.deps.charges.save(charge) // settle is durable before accounting
    }

    // ONE memo for both money records — the Payment's PrivateNote and the
    // receipt tell the same story in the proven live shape.
    const memo = paymentMemo({
      monthLabel: args.monthLabel,
      docNumber: args.docNumber,
      chargeRef: charge.processorRef ?? charge.idempotencyKey,
      authCode: charge.authCode,
      instrumentLabel: chargedLabel,
      at,
    })

    if (charge.status === "settled") {
      const { qboPaymentId } = await this.deps.recorder.record({
        qboInvoiceId,
        amountCents: charge.amountCents,
        memo,
        kind: instrument.kind,
        chargeRef: charge.processorRef ?? charge.idempotencyKey,
        paymentRef: args.docNumber,
      })
      charge.markPaymentRecorded(qboPaymentId, at)
      await this.deps.charges.save(charge)
    }

    if (charge.status === "recorded") {
      await this.deps.receipts.send(customerId, charge.paymentId!, charge.amountCents, memo)
      charge.markReceipted(at)
      await this.deps.charges.save(charge)
    }

    return { outcome: "charged", qboInvoiceId, qboPaymentId: charge.paymentId!, amountCents: charge.amountCents }
  }
}
