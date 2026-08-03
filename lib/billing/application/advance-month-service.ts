/**
 * AdvanceMonth — the one handler the loop, the tail-chain and a button all
 * call.
 *
 * The command names the SUBJECT, never the step: a command that names a step
 * is a stale snapshot the moment anything changes, so the handler asks
 * `nextStep` at claim time and does whatever the month is actually owed.
 * One step per call — each gets its own attempt count, and the chain stops
 * naturally where a person is needed.
 *
 * Nothing here decides anything. Billability, ordering, the calendar, the
 * freeze, the dispute budget — all of it lives on the aggregate, and this
 * service's whole job is to fetch, ask, apply and record.
 */

import {
  priceMonth,
  reconcile,
  type AgreementTermsSource,
  type BillingMonthRepository,
  type ConsumableCatalog,
  type DeliveryFacts,
  type IonInvoiceFacts,
  type NextStep,
} from "@/lib/billing/domain"

export interface AdvanceOutcome {
  monthId: string
  from: string
  step: NextStep
  to: string
  detail: string
  /** True when the month has further work and should be re-enqueued. */
  again: boolean
}

export class AdvanceMonthService {
  constructor(
    private readonly months: BillingMonthRepository,
    private readonly delivery: DeliveryFacts,
    private readonly terms: AgreementTermsSource,
    private readonly catalog: ConsumableCatalog,
    private readonly systemInvoices: IonInvoiceFacts,
  ) {}

  async advance(monthId: string, opts: { now?: Date; dryRun?: boolean } = {}): Promise<AdvanceOutcome> {
    const now = opts.now ?? new Date()
    const at = now.toISOString()
    const month = await this.months.byId(monthId)
    if (!month) throw new Error(`no billing month ${monthId}`)

    const sources = await this.delivery.sourcesFor(month.customerId, month.month)
    const from = month.status
    const step = month.nextStep(sources, now)
    if (step === null) {
      return { monthId, from, step, to: from, detail: this.whyStopped(from), again: false }
    }

    let detail = ""
    switch (step) {
      case "accrue": {
        const [termsList, catalog] = await Promise.all([
          this.terms.termsFor(month.customerId, month.month, at),
          this.catalog.prices(),
        ])
        let claimed = 0
        const refusals: string[] = []
        for (const t of termsList) {
          const priced = priceMonth({ month: month.month, terms: t, sources, catalog, at })
          for (const r of priced.refused) refusals.push(r.reason)
          for (const item of priced.items) {
            month.claim(item, { claimedByMonthId: null }, at)
            claimed++
          }
        }
        detail = `claimed ${claimed} item(s)` + (refusals.length ? `; ${refusals.length} refused: ${refusals[0]}` : "")
        break
      }

      case "reconcile": {
        // A reconcile against a stale report is worth nothing — it would
        // compare fresh arithmetic to yesterday's facts and call it agreement.
        // Coalesced, so this costs one scrape per run, not one per month.
        await this.systemInvoices.refresh(month.month)
        const totals = await this.systemInvoices.perTaskTotals(month.customerId, month.month)
        const result = reconcile(month, totals)
        if (result.agrees) {
          month.markReconciled(at)
          detail = `agrees with the system of record across ${new Set(month.billableItems.map((i) => i.taskId)).size} task(s)`
        } else {
          month.markDisputed(result.findings.map((f) => `${f.rule}: ${f.message}`), at)
          detail = `${result.findings.length} disagreement(s): ${result.findings[0].message}`
        }
        break
      }

      case "refresh_delivery": {
        // The one repull a dispute buys. The REFRESH itself belongs to
        // delivery — we only record that it happened and let the next pass
        // re-accrue on whatever it finds.
        month.markDeliveryRefreshed(at)
        detail = "re-read delivery from the system of record; will re-accrue and reconcile"
        break
      }

      case "gate":
      case "issue":
      case "send":
        // Not yet wired: the gate needs its facts gathered, and issuing needs
        // the invoice builder. Deliberately NOT stubbed as a no-op — a
        // pipeline that silently "advances" past the money steps is worse
        // than one that stops and says so.
        return {
          monthId, from, step, to: from,
          detail: `${step} is not wired yet — Phase 4`,
          again: false,
        }
    }

    if (opts.dryRun) {
      return { monthId, from, step, to: month.status, detail: `dry run: ${detail}`, again: false }
    }

    await this.months.save(month)
    const fresh = await this.months.byId(monthId)
    const next = fresh ? fresh.nextStep(sources, now) : null
    return {
      monthId, from, step, to: fresh?.status ?? month.status, detail,
      // The tail-chain: enqueue again only while there is more to do. The
      // loop would have found it anyway; this just removes the wait.
      again: next !== null && next !== "gate" && next !== "issue" && next !== "send",
    }
  }

  private whyStopped(status: string): string {
    switch (status) {
      case "disputed": return "disputed after a delivery refresh — a person should look"
      case "held": return "held by the gate — a person should look"
      case "sent": return "sent; nothing further"
      default: return "nothing owed right now"
    }
  }
}
