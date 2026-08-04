import { invoiceNextStep, type InvoiceMachineState, type InvoiceStep } from "@/lib/billing/domain"
import { preprocessInvoice, type InvoiceRef, type PreprocessInvoiceDeps } from "./preprocess-service"
import { collectInvoice, sendInvoiceStep, type CollectDeps, type SendDeps } from "./process-service"

/**
 * The AdvanceInvoice HANDLER — the command names the SUBJECT; this asks
 * invoiceNextStep at claim time and runs exactly ONE stage, so a stale
 * command can never run a stale step. `again` drives the tail-chain: the
 * drainer re-enqueues while the machine says there is more to do.
 */

export interface InvoiceStateReader {
  /** The machine's state + the ref, from month_invoices + the mirror. */
  stateFor(qboInvoiceId: string): Promise<{ ref: InvoiceRef; state: InvoiceMachineState } | null>
}

export interface AdvanceInvoiceOutcome {
  qboInvoiceId: string
  step: InvoiceStep
  detail: string
  again: boolean
}

export class AdvanceInvoiceService {
  constructor(
    private readonly reader: InvoiceStateReader,
    private readonly preprocessDeps: PreprocessInvoiceDeps,
    private readonly collectDeps: CollectDeps,
    private readonly sendDeps: SendDeps,
    /** When wired, the collect stage asks this before touching a card —
     * the supervised issue-day switch (billing.policy_flags 'auto_charge'). */
    private readonly autoChargeEnabled?: () => Promise<boolean>,
  ) {}

  async advance(qboInvoiceId: string, now = new Date()): Promise<AdvanceInvoiceOutcome> {
    const loaded = await this.reader.stateFor(qboInvoiceId)
    if (!loaded) return { qboInvoiceId, step: null, detail: "unknown invoice — not one of ours", again: false }
    const step = invoiceNextStep(loaded.state)

    if (step === null) {
      const parked = loaded.state.latestCharge === "declined"
      return { qboInvoiceId, step, detail: parked ? "parked: charge declined — a person decides the next cycle" : "machine done", again: false }
    }

    if (step === "collect" && this.autoChargeEnabled && !(await this.autoChargeEnabled())) {
      return { qboInvoiceId, step, detail: "parked: auto-charge disabled — flip billing.policy_flags 'auto_charge' to resume", again: false }
    }

    let detail = ""
    if (step === "credit_check") {
      const r = await preprocessInvoice(loaded.ref, this.preprocessDeps, now)
      detail = `credits checked${r.appliedCredits.length ? ` · ${r.appliedCredits.length} applied` : " · none decided"}`
    } else if (step === "collect") {
      const r = await collectInvoice(loaded.ref, this.collectDeps, now)
      detail = r.outcome === "charged" ? `charged ${r.amountCents}` : r.outcome
    } else {
      await sendInvoiceStep(loaded.ref, this.sendDeps, now)
      detail = "sent"
    }

    const fresh = await this.reader.stateFor(qboInvoiceId)
    const next = fresh ? invoiceNextStep(fresh.state) : null
    return { qboInvoiceId, step, detail, again: next !== null }
  }
}
